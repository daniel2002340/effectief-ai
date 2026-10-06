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
} from '@effectief/shared';
import { Queue, QueueEvents } from 'bullmq';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workerEnvSchema } from '../src/env.ts';
import { processMailIngestJob, processMailIngestTenant } from '../src/jobs/mail-ingest.ts';
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
        ],
        nextCursor: 'r2',
      },
      { records: [record(message('m3', { backfill: true }), 'r3')], nextCursor: undefined },
    ]);
    const job = { tenantId: A.tenantId, connectionId: connection.id };

    expect(await processMailIngestJob(job, { jobId: 'j1' }, { db: db.app.db, nango, log })).toEqual(
      {
        result: 'ingested',
        pages: 2,
        records: 3,
        created: 2,
        removed: 0,
        invalid: 1,
        pruned: 1,
      },
    );
    expect(asked).toEqual([null, 'r2']);
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
      await processMailIngestJob(job, { jobId: 'j2' }, { db: db.app.db, nango: second.nango, log }),
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
        { db: db.app.db, nango, log },
      ),
    ).toEqual({ result: 'not_active' });
    await asA((tx) =>
      expireConnection(tx, { connectionId: connection.id, reason: 'invalid_grant' }),
    );
    expect(
      await processMailIngestJob(
        { tenantId: A.tenantId, connectionId: connection.id },
        { jobId: 'j4' },
        { db: db.app.db, nango, log },
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
        },
      ),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    expect(
      await asA((tx) => getSyncCursor(tx, { connectionId: connection.id, model: 'InboxMessage' })),
    ).toBe('x1');
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
