import { randomUUID } from 'node:crypto';
import {
  eq,
  expireConnection,
  getEventContent,
  getSyncCursor,
  recordWebhookDelivery,
  schema,
  type TenantTransaction,
  withTenant,
} from '@effectief/db';
import { createTestConnection, openTestDatabases, type TestTenant } from '@effectief/db/testing';
import type { NangoRecord, NangoRecordsPage } from '@effectief/integrations/nango';
import { createFakeNango, nangoTestEnv } from '@effectief/integrations/testing';
import {
  defaultJobOptions,
  type InboxMessage,
  nangoWebhookJobId,
  parseEnv,
  queueNames,
  type ReportError,
} from '@effectief/shared';
import { Queue, QueueEvents } from 'bullmq';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workerEnvSchema } from '../src/env.ts';
import {
  InvalidMailRecordError,
  processMailIngestJob,
  processMailIngestTenant,
} from '../src/jobs/mail-ingest.ts';
import { processRetentionTenantJob } from '../src/jobs/retention.ts';
import { startWorkers } from '../src/worker.ts';

// Job mail-ingest (docs/integrations.md §4.2–§4.5): records from the
// connection's own cursor, one transaction per page, deleted mail loses its
// content, an invalid record is skipped without blocking the rest, and
// Nango's copy is pruned to the stored cursor.

const env = parseEnv(workerEnvSchema, { ...process.env, ...nangoTestEnv, LOG_LEVEL: 'silent' });
const log = pino({ level: 'silent' });
const db = openTestDatabases();
let A: TestTenant;
let B: TestTenant;

const noReport: ReportError = () => {};

/** Collects what would go to Sentry. */
function collectReports() {
  const reports: { error: unknown; context: Record<string, string | number | undefined> }[] = [];
  const reportError: ReportError = (error, context) => void reports.push({ error, context });
  return { reports, reportError };
}

const asA = <T>(fn: (tx: TenantTransaction) => Promise<T>) => withTenant(db.app.db, A.tenantId, fn);

beforeAll(async () => {
  A = await db.createTenant();
  B = await db.createTenant();
});
afterAll(() => db.close());

function message(id: string, overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    id,
    threadId: `t-${id}`,
    internetMessageId: `<${id}@mail.example>`,
    receivedAt: '2026-10-06T08:00:00.000Z',
    from: { address: 'Jan@Klant.example', name: 'Jan Klant' },
    to: ['info@bedrijf.example'],
    cc: [],
    subject: 'Offerte',
    bodyText: 'Kunt u een offerte sturen?',
    labels: ['INBOX', 'UNREAD'],
    attachments: [
      { name: 'tekening.pdf', mimeType: 'application/pdf', size: 1234, attachmentId: '2' },
    ],
    backfill: false,
    ...overrides,
  };
}

const record = (
  fields: Record<string, unknown>,
  cursor: string,
  extra: Partial<NangoRecord> = {},
) => ({ fields, cursor, deleted: false, pruned: false, ...extra }) satisfies NangoRecord;

/** A fake Nango with fixed pages, recording the cursors it was asked for. */
function fakeRecords(pages: NangoRecordsPage[]) {
  const asked: (string | null)[] = [];
  const pruned: string[] = [];
  const nango = createFakeNango({
    listRecords: async (_ref, { cursor }) => {
      asked.push(cursor);
      return pages[asked.length - 1] ?? { records: [], nextCursor: undefined };
    },
    pruneRecords: async (_ref, { untilCursor }) => {
      pruned.push(untilCursor);
      return { count: 1 };
    },
  });
  return { nango, asked, pruned };
}

describe('processMailIngestJob', () => {
  it('takes in pages from the cursor, skips invalid records and prunes', async () => {
    const connection = await asA((tx) => createTestConnection(tx, A));
    const { nango, asked, pruned } = fakeRecords([
      {
        records: [
          record(message('m1'), 'r1'),
          record({ ...message('m2'), html: '<p>niet toegestaan</p>' }, 'r2'),
          record({ ...message('m2b'), threadId: 42 }, 'r2b'),
        ],
        nextCursor: 'r2b',
      },
      { records: [record(message('m3', { backfill: true }), 'r3')], nextCursor: undefined },
    ]);
    const job = { tenantId: A.tenantId, connectionId: connection.id };
    const { reports, reportError } = collectReports();

    expect(
      await processMailIngestJob(job, { jobId: 'j1' }, { db: db.app.db, nango, log, reportError }),
    ).toEqual({
      result: 'ingested',
      pages: 2,
      records: 4,
      created: 2,
      removed: 0,
      invalid: 2,
      pruned: 1,
    });

    // One Sentry report per invalid record, with identifiers only.
    expect(reports.map(({ context }) => context)).toEqual(
      ['m2', 'm2b'].map((recordId) => ({
        tenantId: A.tenantId,
        connectionId: connection.id,
        jobId: 'j1',
        recordId,
      })),
    );
    for (const { error } of reports) {
      expect(error).toBeInstanceOf(InvalidMailRecordError);
      const text = JSON.stringify(error, Object.getOwnPropertyNames(error));
      expect(text).not.toMatch(/niet toegestaan|offerte|klant\.example|Jan/i);
    }
    expect(asked).toEqual([null, 'r2b']);
    expect(pruned).toEqual(['r3']);

    await asA(async (tx) => {
      expect(await getSyncCursor(tx, { connectionId: connection.id, model: 'InboxMessage' })).toBe(
        'r3',
      );
      const rows = await tx
        .select()
        .from(schema.events)
        .where(eq(schema.events.connectionId, connection.id));
      expect(rows.map((row) => row.externalId).sort()).toEqual(['m1', 'm3']);
      const m1 = rows.find((row) => row.externalId === 'm1');
      expect(m1?.internetMessageId).toBe('<m1@mail.example>');
      expect(m1?.payload).toEqual({
        attachmentCount: 1,
        labels: ['INBOX', 'UNREAD'],
        backfill: false,
      });
      expect(await getEventContent(tx, m1?.id ?? '')).toMatchObject({
        fromAddress: 'jan@klant.example',
        fromName: 'Jan Klant',
        attachments: [
          {
            name: 'tekening.pdf',
            mimeType: 'application/pdf',
            size: 1234,
            providerAttachmentId: '2',
          },
        ],
      });
    });

    // A deleted record at Nango: the content goes, the event stays; pruned ones are skipped.
    const second = fakeRecords([
      {
        records: [
          record({ id: 'm1' }, 'r4', { deleted: true }),
          record({}, 'r5', { pruned: true }),
        ],
        nextCursor: undefined,
      },
    ]);
    expect(
      await processMailIngestJob(
        job,
        { jobId: 'j2' },
        { db: db.app.db, nango: second.nango, log, reportError: noReport },
      ),
    ).toMatchObject({ result: 'ingested', removed: 1, created: 0 });
    expect(second.asked).toEqual(['r3']);
    await asA(async (tx) => {
      const [m1] = await tx.select().from(schema.events).where(eq(schema.events.externalId, 'm1'));
      expect(m1).toBeDefined();
      expect(await getEventContent(tx, m1?.id ?? '')).toBeUndefined();
    });
  });

  it('does nothing for a connection that is not active, or of another tenant', async () => {
    const connection = await asA((tx) => createTestConnection(tx, A));
    const { nango, asked } = fakeRecords([]);
    expect(
      await processMailIngestJob(
        { tenantId: B.tenantId, connectionId: connection.id },
        { jobId: 'j3' },
        { db: db.app.db, nango, log, reportError: noReport },
      ),
    ).toEqual({ result: 'not_active' });
    await asA((tx) =>
      expireConnection(tx, { connectionId: connection.id, reason: 'invalid_grant' }),
    );
    expect(
      await processMailIngestJob(
        { tenantId: A.tenantId, connectionId: connection.id },
        { jobId: 'j4' },
        { db: db.app.db, nango, log, reportError: noReport },
      ),
    ).toEqual({ result: 'not_active' });
    expect(asked).toEqual([]);
  });

  it('fails the job when pruning fails, with the pages already taken in', async () => {
    const connection = await asA((tx) => createTestConnection(tx, A));
    const nango = createFakeNango({
      listRecords: async () => ({
        records: [record(message(`f-${randomUUID()}`), 'x1')],
        nextCursor: 'x1',
      }),
    });
    // Pruning fails (Nango down): the job retries; the taken-in page stays.
    await expect(
      processMailIngestJob(
        { tenantId: A.tenantId, connectionId: connection.id },
        { jobId: 'j5' },
        {
          db: db.app.db,
          nango: {
            ...nango,
            listRecords: async (ref, input) =>
              input.cursor ? { records: [], nextCursor: undefined } : nango.listRecords(ref, input),
          },
          log,
          reportError: noReport,
        },
      ),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    expect(
      await asA((tx) => getSyncCursor(tx, { connectionId: connection.id, model: 'InboxMessage' })),
    ).toBe('x1');
  });
});

describe('two tenants syncing at the same time', () => {
  it('each takes in only its own mail and moves only its own cursor', async () => {
    const tenants = [await db.createTenant(), await db.createTenant()];
    const connections = await Promise.all(
      tenants.map((tenant) =>
        withTenant(db.app.db, tenant.tenantId, (tx) => createTestConnection(tx, tenant)),
      ),
    );
    // The same Gmail message IDs in both mailboxes; only the subject tells them apart.
    const pagesFor = (label: string): NangoRecordsPage[] => [
      {
        records: [
          record(message('s1', { subject: `Voor ${label}` }), `${label}-1`),
          record(message('s2', { subject: `Voor ${label}` }), `${label}-2`),
        ],
        nextCursor: `${label}-2`,
      },
      {
        records: [record(message('s3', { subject: `Voor ${label}` }), `${label}-3`)],
        nextCursor: undefined,
      },
    ];
    const byConnection = new Map(
      connections.map((connection, index) => [
        connection.nangoConnectionId,
        { pages: pagesFor(String(index)), asked: [] as (string | null)[] },
      ]),
    );
    const nango = createFakeNango({
      listRecords: async (ref, { cursor }) => {
        const own = byConnection.get(ref.connectionId);
        if (!own) throw new Error('unknown connection');
        own.asked.push(cursor);
        // Let the other tenant's ingest run in between.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return own.pages[own.asked.length - 1] ?? { records: [], nextCursor: undefined };
      },
      pruneRecords: async () => ({ count: 0 }),
    });

    const results = await Promise.all(
      tenants.map((tenant, index) =>
        processMailIngestJob(
          { tenantId: tenant.tenantId, connectionId: connections[index]?.id ?? '' },
          { jobId: `parallel-${index}` },
          { db: db.app.db, nango, log, reportError: noReport },
        ),
      ),
    );
    expect(results.map((result) => result.result)).toEqual(['ingested', 'ingested']);

    for (const [index, tenant] of tenants.entries()) {
      const connection = connections[index];
      await withTenant(db.app.db, tenant.tenantId, async (tx) => {
        const rows = await tx.select().from(schema.events);
        expect(rows.map((row) => row.externalId).sort()).toEqual(['s1', 's2', 's3']);
        expect(rows.every((row) => row.connectionId === connection?.id)).toBe(true);
        for (const row of rows) {
          expect((await getEventContent(tx, row.id))?.subject).toBe(`Voor ${index}`);
        }
        const cursors = await tx.select().from(schema.syncCursors);
        expect(cursors.map(({ connectionId, cursor }) => ({ connectionId, cursor }))).toEqual([
          { connectionId: connection?.id, cursor: `${index}-3` },
        ]);
      });
    }
  });
});

describe('retention of taken-in content', () => {
  it('sets retain_until from the tenant’s period and the retention job removes it', async () => {
    const tenant = await db.createTenant();
    const asTenant = <T>(fn: (tx: TenantTransaction) => Promise<T>) =>
      withTenant(db.app.db, tenant.tenantId, fn);
    await asTenant((tx) => tx.update(schema.tenantSettings).set({ contentRetentionDays: 30 }));
    const connection = await asTenant((tx) => createTestConnection(tx, tenant));
    const { nango } = fakeRecords([
      {
        records: [record(message('old', { receivedAt: '2026-09-01T08:00:00.000Z' }), 'o1')],
        nextCursor: undefined,
      },
    ]);
    await processMailIngestJob(
      { tenantId: tenant.tenantId, connectionId: connection.id },
      { jobId: 'retention-ingest' },
      { db: db.app.db, nango, log, reportError: noReport },
    );
    const event = await asTenant(async (tx) => {
      const [row] = await tx.select().from(schema.events);
      expect(row?.occurredAt).toEqual(new Date('2026-09-01T08:00:00Z'));
      // occurred_at + 30 days
      expect((await getEventContent(tx, row?.id ?? ''))?.retainUntil).toEqual(
        new Date('2026-10-01T08:00:00Z'),
      );
      return row;
    });

    const runAt = (iso: string) =>
      processRetentionTenantJob(
        { tenantId: tenant.tenantId },
        { jobId: `retention-${iso}` },
        { db: db.app.db, log, now: () => new Date(iso) },
      );
    expect((await runAt('2026-10-01T07:59:00Z')).event_contents).toBe(0);
    expect(await asTenant((tx) => getEventContent(tx, event?.id ?? ''))).toBeDefined();

    expect((await runAt('2026-10-01T08:01:00Z')).event_contents).toBe(1);
    await asTenant(async (tx) => {
      expect(await getEventContent(tx, event?.id ?? '')).toBeUndefined();
      const [kept] = await tx.select().from(schema.events);
      expect(kept?.id).toBe(event?.id);
      expect(kept?.internetMessageId).toBe('<old@mail.example>');
      const purged = await tx
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, 'retention.purged'));
      expect(purged.map((entry) => entry.metadata)).toEqual([{ step: 'event_contents', count: 1 }]);
    });
  });
});

describe('processMailIngestTenant', () => {
  it('enqueues one job per active mail connection of that tenant only', async () => {
    const tenant = await db.createTenant();
    const other = await db.createTenant();
    const [mail, expired] = await withTenant(db.app.db, tenant.tenantId, async (tx) => [
      await createTestConnection(tx, tenant),
      await createTestConnection(tx, tenant),
      await createTestConnection(tx, tenant, 'moneybird'),
    ]);
    await withTenant(db.app.db, tenant.tenantId, (tx) =>
      expireConnection(tx, { connectionId: expired?.id ?? '', reason: 'invalid_grant' }),
    );
    await withTenant(db.app.db, other.tenantId, (tx) => createTestConnection(tx, other));
    const enqueued: unknown[] = [];
    await processMailIngestTenant(
      { tenantId: tenant.tenantId },
      { db: db.app.db, enqueueIngest: async (jobs) => void enqueued.push(...jobs) },
    );
    expect(enqueued).toEqual([{ tenantId: tenant.tenantId, connectionId: mail?.id }]);
  });
});

describe('through the queue', () => {
  it('a sync webhook leads to an ingest of that connection', async () => {
    const prefix = `test-${randomUUID()}`;
    const connection = { url: env.REDIS_URL, maxRetriesPerRequest: null };
    const mailbox = await asA((tx) => createTestConnection(tx, A));
    const id = `q-${randomUUID()}`;
    const { nango } = fakeRecords([
      { records: [record(message(id), 'q1')], nextCursor: undefined },
    ]);
    const workers = startWorkers({
      connection,
      log,
      prefix,
      db: db.app.db,
      adapters: {},
      reportError: () => {},
      nango,
      testErrors: false,
    });
    const webhooks = new Queue(queueNames.nangoWebhook, { connection, prefix, defaultJobOptions });
    const ingestEvents = new QueueEvents(queueNames.mailIngest, { connection, prefix });
    const ingestQueue = new Queue(queueNames.mailIngest, { connection, prefix });
    try {
      await ingestEvents.waitUntilReady();
      const delivery = await asA(async (tx) => {
        const stored = await recordWebhookDelivery(tx, {
          connectionId: mailbox.id,
          source: 'nango',
          deliveryId: randomUUID().replaceAll('-', ''),
          payload: {
            type: 'sync',
            connectionId: mailbox.nangoConnectionId,
            providerConfigKey: 'gmail',
            syncName: 'inbox-messages',
            model: 'InboxMessage',
            success: true,
          },
        });
        return stored.delivery;
      });
      const done = new Promise<void>((resolve) => {
        ingestEvents.on('completed', () => resolve());
      });
      await webhooks.add(
        'process',
        { tenantId: A.tenantId, deliveryId: delivery.id },
        { jobId: nangoWebhookJobId(delivery.id) },
      );
      await done;
      const [event] = await asA((tx) =>
        tx.select().from(schema.events).where(eq(schema.events.externalId, id)),
      );
      expect(event?.connectionId).toBe(mailbox.id);
    } finally {
      await workers.close();
      await ingestEvents.close();
      await webhooks.obliterate({ force: true });
      await webhooks.close();
      await ingestQueue.obliterate({ force: true });
      await ingestQueue.close();
    }
  });
});
