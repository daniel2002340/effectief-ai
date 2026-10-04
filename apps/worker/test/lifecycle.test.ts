import { randomUUID } from 'node:crypto';
import {
  createEntity,
  disconnectConnection,
  getConnection,
  getEntity,
  getEventContent,
  recordEvent,
  type TenantTransaction,
  withTenant,
} from '@effectief/db';
import {
  asUser,
  createTestConnection,
  openTestDatabases,
  type TestTenant,
} from '@effectief/db/testing';
import {
  defaultJobOptions,
  parseEnv,
  queueNames,
  retentionJobNames,
  retentionTenantJobId,
} from '@effectief/shared';
import { Queue, QueueEvents } from 'bullmq';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workerEnvSchema } from '../src/env.ts';
import {
  processRetentionSweep,
  retentionSchedule,
  scheduleRetention,
} from '../src/jobs/retention.ts';
import { startWorkers } from '../src/worker.ts';

// Retention, forgetting and purging as jobs, through Valkey with an own key
// prefix, against Postgres as app_runtime.

const env = parseEnv(workerEnvSchema, { ...process.env, LOG_LEVEL: 'silent' });
const log = pino({ level: 'silent' });
const db = openTestDatabases();
const prefix = `test-${randomUUID()}`;
const connection = { url: env.REDIS_URL, maxRetriesPerRequest: null };
const workers = startWorkers({ connection, log, prefix, db: db.app.db, adapters: {} });
const queues = {
  forget: new Queue(queueNames.forgetEntity, { connection, prefix, defaultJobOptions }),
  purge: new Queue(queueNames.purgeConnection, { connection, prefix, defaultJobOptions }),
};
const events = {
  retention: new QueueEvents(queueNames.retention, { connection, prefix }),
  forget: new QueueEvents(queueNames.forgetEntity, { connection, prefix }),
  purge: new QueueEvents(queueNames.purgeConnection, { connection, prefix }),
};
let tenant: TestTenant;

const inTenant = <T>(fn: (tx: TenantTransaction) => Promise<T>) =>
  withTenant(db.app.db, tenant.tenantId, fn);

beforeAll(async () => {
  tenant = await db.createTenant();
  await Promise.all(Object.values(events).map((e) => e.waitUntilReady()));
});
afterAll(async () => {
  await workers.retentionQueue.obliterate({ force: true });
  await workers.close();
  await Promise.all(Object.values(events).map((e) => e.close()));
  for (const queue of Object.values(queues)) {
    await queue.obliterate({ force: true });
    await queue.close();
  }
  await db.close();
});

describe('retention', () => {
  it('is scheduled daily at 03:00 Amsterdam time, once', async () => {
    await scheduleRetention(workers.retentionQueue);
    await scheduleRetention(workers.retentionQueue);
    const schedulers = await workers.retentionQueue.getJobSchedulers();
    expect(schedulers).toMatchObject([
      { key: 'retention-sweep', name: retentionJobNames.sweep, ...retentionSchedule },
    ]);
    await workers.retentionQueue.removeJobScheduler('retention-sweep');
  });

  it('the sweep enqueues one job per tenant, with the tenant in the payload', async () => {
    const enqueued: { tenantId: string; jobId: string }[] = [];
    const day = new Date('2026-10-04T01:00:00Z');
    const result = await processRetentionSweep(
      {},
      {
        db: db.app.db,
        log,
        now: () => day,
        enqueueTenants: async (jobs) => void enqueued.push(...jobs),
      },
    );
    expect(result.tenants).toBe(enqueued.length);
    expect(enqueued).toContainEqual({
      tenantId: tenant.tenantId,
      jobId: retentionTenantJobId(tenant.tenantId, day),
    });
  });

  it('a tenant job deletes expired content and keeps the event', async () => {
    const event = await inTenant(async (tx) => {
      const { event } = await recordEvent(tx, {
        event: {
          source: 'app',
          externalId: `note-${randomUUID()}`,
          type: 'note.added',
          occurredAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
          payload: {},
        },
        content: { bodyText: 'Oude notitie' },
      });
      return event;
    });
    const job = await workers.retentionQueue.add(
      retentionJobNames.tenant,
      { tenantId: tenant.tenantId },
      { jobId: retentionTenantJobId(tenant.tenantId, new Date()) },
    );
    await expect(job.waitUntilFinished(events.retention, 10_000)).resolves.toMatchObject({
      event_contents: 1,
    });
    expect(await inTenant((tx) => getEventContent(tx, event.id))).toBeUndefined();
  });
});

describe('forget-entity', () => {
  it('forgets the entity as the owner who asked', async () => {
    const entity = await inTenant((tx) => createEntity(tx, { type: 'contact', name: 'Jan Weg' }));
    const job = await queues.forget.add('forget', {
      tenantId: tenant.tenantId,
      entityId: entity.id,
      requestedByUserId: tenant.userId,
    });
    await expect(job.waitUntilFinished(events.forget, 10_000)).resolves.toMatchObject({
      entities: 1,
    });
    expect(await inTenant((tx) => getEntity(tx, entity.id))).toBeUndefined();
  });
});

describe('purge-connection', () => {
  it('purges a revoked connection', async () => {
    const created = await inTenant(async (tx) => {
      const gmail = await createTestConnection(tx, tenant);
      await disconnectConnection(tx, { connectionId: gmail.id, actor: asUser(tenant.userId) });
      return gmail;
    });
    const job = await queues.purge.add('purge', {
      tenantId: tenant.tenantId,
      connectionId: created.id,
    });
    await expect(job.waitUntilFinished(events.purge, 10_000)).resolves.toMatchObject({
      purged: true,
    });
    expect((await inTenant((tx) => getConnection(tx, created.id)))?.status).toBe('purged');
  });

  it('an active connection fails the job at once, without retries', async () => {
    const active = await inTenant((tx) => createTestConnection(tx, tenant));
    const job = await queues.purge.add('purge', {
      tenantId: tenant.tenantId,
      connectionId: active.id,
    });
    await expect(job.waitUntilFinished(events.purge, 10_000)).rejects.toThrow(/purge refused/);
    const failed = await queues.purge.getJob(job.id ?? '');
    expect(failed?.attemptsMade).toBe(1);
    expect((await inTenant((tx) => getConnection(tx, active.id)))?.status).toBe('active');
  });
});
