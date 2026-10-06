import { randomUUID } from 'node:crypto';
import {
  getWebhookDelivery,
  recordWebhookDelivery,
  schema,
  type TenantTransaction,
  withTenant,
} from '@effectief/db';
import { createTestConnection, openTestDatabases, type TestTenant } from '@effectief/db/testing';
import { createFakeNango, nangoTestEnv } from '@effectief/integrations/testing';
import {
  defaultJobOptions,
  nangoWebhookJobId,
  parseEnv,
  queueNames,
  type StoredNangoWebhook,
} from '@effectief/shared';
import { Queue, QueueEvents } from 'bullmq';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workerEnvSchema } from '../src/env.ts';
import { processNangoWebhookJob } from '../src/jobs/nango-webhook.ts';
import { startWorkers } from '../src/worker.ts';

// Job nango-webhook (docs/integrations.md §4.1): a stored delivery is
// processed once, within its tenant, and a failure stays visible.

const env = parseEnv(workerEnvSchema, { ...process.env, ...nangoTestEnv, LOG_LEVEL: 'silent' });
const log = pino({ level: 'silent' });
const db = openTestDatabases();
let A: TestTenant;
let B: TestTenant;
let connectionA: { id: string; nangoConnectionId: string };

const asA = <T>(fn: (tx: TenantTransaction) => Promise<T>) => withTenant(db.app.db, A.tenantId, fn);

const payload = (): StoredNangoWebhook => ({
  type: 'sync',
  connectionId: connectionA.nangoConnectionId,
  providerConfigKey: 'google-mail',
  syncName: 'inbox-messages',
  model: 'InboxMessage',
  success: true,
});

const storeDelivery = () =>
  asA(async (tx) => {
    const { delivery } = await recordWebhookDelivery(tx, {
      connectionId: connectionA.id,
      source: 'nango',
      deliveryId: randomUUID().replaceAll('-', ''),
      payload: payload(),
    });
    return delivery;
  });

beforeAll(async () => {
  A = await db.createTenant();
  B = await db.createTenant();
  connectionA = await asA((tx) => createTestConnection(tx, A));
});
afterAll(() => db.close());

describe('processNangoWebhookJob', () => {
  it('runs the handler and marks the delivery processed, once', async () => {
    const delivery = await storeDelivery();
    const seen: string[] = [];
    const handlers = {
      sync: async () => {
        seen.push(delivery.id);
      },
    };
    const job = { tenantId: A.tenantId, deliveryId: delivery.id };
    expect(
      await processNangoWebhookJob(job, { jobId: 'j1' }, { db: db.app.db, log, handlers }),
    ).toEqual({ processed: true });
    expect(
      await processNangoWebhookJob(job, { jobId: 'j2' }, { db: db.app.db, log, handlers }),
    ).toEqual({ processed: false });
    expect(seen).toEqual([delivery.id]);
    expect(await asA((tx) => getWebhookDelivery(tx, delivery.id))).toMatchObject({
      status: 'processed',
      attempts: 1,
    });
  });

  it('rolls the effects back on failure, marks the delivery failed and rethrows', async () => {
    const delivery = await storeDelivery();
    const handlers = {
      sync: async ({
        commit,
      }: {
        commit: <T>(fn: (tx: TenantTransaction) => Promise<T>) => Promise<T>;
      }) => {
        await commit(async (tx) => {
          await tx.insert(schema.webhookDeliveries).values({
            connectionId: connectionA.id,
            source: 'nango',
            deliveryId: `effect-${delivery.id}`,
            payload: payload(),
          });
          throw new Error('provider down');
        });
      },
    };
    await expect(
      processNangoWebhookJob(
        { tenantId: A.tenantId, deliveryId: delivery.id },
        { jobId: 'j3' },
        { db: db.app.db, log, handlers },
      ),
    ).rejects.toThrow('provider down');
    const rows = await asA((tx) => tx.select().from(schema.webhookDeliveries));
    expect(rows.some((row) => row.deliveryId === `effect-${delivery.id}`)).toBe(false);
    expect(rows.find((row) => row.id === delivery.id)).toMatchObject({
      status: 'failed',
      lastErrorCode: 'unknown',
      attempts: 1,
    });
  });

  it('does not touch a delivery of another tenant', async () => {
    const delivery = await storeDelivery();
    const result = await processNangoWebhookJob(
      { tenantId: B.tenantId, deliveryId: delivery.id },
      { jobId: 'j4' },
      { db: db.app.db, log, handlers: { sync: async () => {} } },
    );
    expect(result).toEqual({ processed: false });
    expect(await asA((tx) => getWebhookDelivery(tx, delivery.id))).toMatchObject({
      status: 'received',
      attempts: 0,
    });
  });

  it('refuses a payload without a valid tenant or delivery id', async () => {
    await expect(
      processNangoWebhookJob({ deliveryId: randomUUID() }, { jobId: 'j5' }, { db: db.app.db, log }),
    ).rejects.toThrow();
  });
});

describe('through the queue', () => {
  it('processes an enqueued delivery, and ignores a second enqueue of it', async () => {
    const prefix = `test-${randomUUID()}`;
    const connection = { url: env.REDIS_URL, maxRetriesPerRequest: null };
    const workers = startWorkers({
      connection,
      log,
      prefix,
      db: db.app.db,
      adapters: {},
      reportError: () => {},
      nango: createFakeNango(),
      testErrors: false,
    });
    const queue = new Queue(queueNames.nangoWebhook, { connection, prefix, defaultJobOptions });
    const events = new QueueEvents(queueNames.nangoWebhook, { connection, prefix });
    try {
      await events.waitUntilReady();
      const delivery = await storeDelivery();
      const data = { tenantId: A.tenantId, deliveryId: delivery.id };
      const job = await queue.add('process', data, { jobId: nangoWebhookJobId(delivery.id) });
      const again = await queue.add('process', data, { jobId: nangoWebhookJobId(delivery.id) });
      expect(again.id).toBe(job.id);
      await job.waitUntilFinished(events, 10_000);
      expect(await asA((tx) => getWebhookDelivery(tx, delivery.id))).toMatchObject({
        status: 'processed',
      });
    } finally {
      await workers.close();
      await events.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});
