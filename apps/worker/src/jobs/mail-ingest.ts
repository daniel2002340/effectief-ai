import {
  applyMailPage,
  type Database,
  getConnection,
  getSyncCursor,
  listConnections,
  listTenantIds,
  type MailPageItem,
  withTenant,
} from '@effectief/db';
import { normalizeInboxMessage, parseInboxRecord } from '@effectief/integrations/mail';
import { type NangoClient, nangoIntegrationIds } from '@effectief/integrations/nango';
import {
  defaultJobOptions,
  INBOX_MESSAGE_MODEL,
  type MailIngestJob,
  mailIngestJobNames,
  mailIngestJobSchema,
  mailIngestSweepJobSchema,
  mailIngestTenantJobSchema,
  type ReportError,
} from '@effectief/shared';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';

// Mail ingest (docs/integrations.md §4.2–§4.3, #076): read a mail connection's
// InboxMessage records from Nango, page by page from its own cursor, and take
// each page in with one transaction (events, content, links, cursor, audit).
// No transaction is open during a Nango call. After the last page, Nango's
// copy is pruned up to the stored cursor (§3.5).

const MAIL_INGEST_SWEEP_EVERY_MS = 10 * 60 * 1000;

/** Idempotent: run at every worker start, updates the scheduler. */
export async function scheduleMailIngestSweep(queue: Queue) {
  await queue.upsertJobScheduler(
    'mail-ingest-sweep',
    { every: MAIL_INGEST_SWEEP_EVERY_MS },
    { name: mailIngestJobNames.sweep, data: {}, opts: defaultJobOptions },
  );
}

const mailProviders = ['gmail', 'outlook'] as const;
type MailProvider = (typeof mailProviders)[number];
const isMailProvider = (provider: string): provider is MailProvider =>
  (mailProviders as readonly string[]).includes(provider);

/** Reported to Sentry; carries no content, only the identifiers in its context. */
export class InvalidMailRecordError extends Error {
  override name = 'InvalidMailRecordError';
  constructor() {
    super('invalid mail record');
  }
}

/** A run reads at most this many pages; the next webhook or sweep goes on. */
const MAX_PAGES = 50;

export interface MailIngestDependencies {
  db: Database;
  nango: Pick<NangoClient, 'listRecords' | 'pruneRecords'>;
  log: Logger;
  /** One Sentry report per invalid record, with identifiers only. */
  reportError: ReportError;
}

export type MailIngestResult =
  | { result: 'not_active' | 'cursor_moved' }
  | {
      result: 'ingested';
      pages: number;
      records: number;
      created: number;
      removed: number;
      invalid: number;
      pruned: number;
    };

export async function processMailIngestJob(
  data: unknown,
  job: { jobId: string },
  { db, nango, log, reportError }: MailIngestDependencies,
): Promise<MailIngestResult> {
  const { tenantId, connectionId } = mailIngestJobSchema.parse(data);
  const ids = { tenantId, connectionId, jobId: job.jobId };

  const start = await withTenant(db, tenantId, async (tx) => {
    const connection = await getConnection(tx, connectionId);
    if (connection?.status !== 'active' || !isMailProvider(connection.provider)) return undefined;
    const cursor = await getSyncCursor(tx, { connectionId, model: INBOX_MESSAGE_MODEL });
    return {
      provider: connection.provider,
      nangoConnectionId: connection.nangoConnectionId,
      cursor,
    };
  });
  if (!start) return { result: 'not_active' };

  const ref = {
    integrationId: nangoIntegrationIds[start.provider],
    connectionId: start.nangoConnectionId,
  };
  const totals = { pages: 0, records: 0, created: 0, removed: 0, invalid: 0 };
  let cursor = start.cursor;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { records, nextCursor } = await nango.listRecords(ref, {
      model: INBOX_MESSAGE_MODEL,
      cursor,
    });
    const last = records.at(-1);
    if (!last) break;

    const items = records.map((record): MailPageItem => {
      const id = record.fields.id;
      if (record.deleted) {
        return typeof id === 'string'
          ? { kind: 'removed', source: start.provider, externalId: id }
          : { kind: 'invalid' };
      }
      if (record.pruned) return { kind: 'skipped' };
      const message = parseInboxRecord(record.fields);
      const mail =
        message && normalizeInboxMessage(message, { source: start.provider, connectionId });
      if (!mail) {
        // Never the record or the parse error: they hold mail content (CLAUDE.md, logging).
        const recordId = typeof id === 'string' ? id : undefined;
        log.warn({ ...ids, recordId }, 'invalid mail record');
        reportError(new InvalidMailRecordError(), { ...ids, recordId });
        return { kind: 'invalid' };
      }
      return { kind: 'message', ...mail };
    });

    const applied = await withTenant(db, tenantId, (tx) =>
      applyMailPage(tx, {
        connectionId,
        model: INBOX_MESSAGE_MODEL,
        fromCursor: cursor,
        toCursor: last.cursor,
        items,
        context: { jobId: job.jobId },
      }),
    );
    if (!applied.applied) {
      log.info(ids, 'mail ingest stopped: cursor moved or connection no longer active');
      return { result: 'cursor_moved' };
    }
    totals.pages += 1;
    totals.records += applied.records;
    totals.created += applied.created;
    totals.removed += applied.removed;
    totals.invalid += applied.invalid;
    cursor = last.cursor;
    if (!nextCursor) break;
  }

  // Idempotent: a failed prune is retried by the job, or goes along with the next run.
  const pruned = cursor
    ? (await nango.pruneRecords(ref, { model: INBOX_MESSAGE_MODEL, untilCursor: cursor })).count
    : 0;
  log.info({ ...ids, ...totals, pruned }, 'mail ingested');
  return { result: 'ingested', ...totals, pruned };
}

/** The sweep lists tenant ids only and enqueues one job per tenant (as retention, #052). */
export async function processMailIngestSweep(
  data: unknown,
  { db, enqueueTenants }: { db: Database; enqueueTenants: (tenantIds: string[]) => Promise<void> },
) {
  mailIngestSweepJobSchema.parse(data);
  const tenantIds = await listTenantIds(db);
  await enqueueTenants(tenantIds);
  return { tenants: tenantIds.length };
}

/** One ingest job per active mail connection of the tenant. */
export async function processMailIngestTenant(
  data: unknown,
  { db, enqueueIngest }: { db: Database; enqueueIngest: (jobs: MailIngestJob[]) => Promise<void> },
) {
  const { tenantId } = mailIngestTenantJobSchema.parse(data);
  const connections = await withTenant(db, tenantId, (tx) => listConnections(tx, 'active'));
  const jobs = connections
    .filter((connection) => isMailProvider(connection.provider))
    .map((connection) => ({ tenantId, connectionId: connection.id }));
  await enqueueIngest(jobs);
  return { connections: jobs.length };
}
