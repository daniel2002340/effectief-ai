import { randomUUID } from 'node:crypto';
import { createDatabase } from '@effectief/db';
import {
  MonitoringTestError,
  monitoringTestJobOptions,
  parseEnv,
  queueNames,
} from '@effectief/shared';
import { Queue, QueueEvents } from 'bullmq';
import { pino } from 'pino';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { workerEnvSchema } from '../src/env.ts';
import { failedJobContext, startWorkers } from '../src/worker.ts';

const env = parseEnv(workerEnvSchema, { ...process.env, LOG_LEVEL: 'silent' });
const log = pino({ level: 'silent' });
const TENANT = '00000000-0000-4000-8000-00000000000b';
const connection = { url: env.REDIS_URL, maxRetriesPerRequest: null };

describe('failedJobContext', () => {
  it('reports identifiers and the parsed tenant, never the payload', () => {
    const context = failedJobContext('example', {
      id: '42',
      name: 'example',
      attemptsMade: 5,
      data: { tenantId: TENANT, note: 'Beste Jan, bel 06-12345678' },
    });
    expect(context).toEqual({
      queue: 'example',
      jobName: 'example',
      jobId: '42',
      attempts: 5,
      tenantId: TENANT,
    });
    expect(JSON.stringify(context)).not.toContain('Beste Jan');
  });

  it('reports no tenant when the payload has no valid one', () => {
    for (const data of [{ tenantId: 'not-a-uuid' }, null, 'tekst']) {
      expect(
        failedJobContext('example', { id: '1', name: 'example', attemptsMade: 1, data }).tenantId,
      ).toBeUndefined();
    }
  });
});

describe('monitoring-test queue (Valkey)', () => {
  const prefix = `test-${randomUUID()}`;
  const queue = new Queue(queueNames.monitoringTest, {
    connection,
    prefix,
    defaultJobOptions: monitoringTestJobOptions,
  });
  const events = new QueueEvents(queueNames.monitoringTest, { connection, prefix });
  const database = createDatabase(env.DATABASE_URL);
  const reported: { error: unknown; context: Record<string, unknown> }[] = [];
  const reportError = (error: unknown, context: Record<string, unknown>) =>
    reported.push({ error, context });
  const workers = startWorkers({
    connection,
    log,
    prefix,
    db: database.db,
    adapters: {},
    reportError,
    testErrors: true,
  });
  const production = startWorkers({
    connection,
    log,
    prefix: `${prefix}-production`,
    db: database.db,
    adapters: {},
    reportError,
    testErrors: false,
  });

  afterAll(async () => {
    await Promise.all([workers.close(), production.close()]);
    await database.close();
    await events.close();
    await queue.obliterate({ force: true });
    await queue.close();
  });

  it('fails on every attempt and is reported once, after the last one, with IDs only', async () => {
    await events.waitUntilReady();
    const job = await queue.add('fail', { tenantId: TENANT });
    await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow(/Testfout in worker/);

    await vi.waitFor(() => expect(reported).toHaveLength(1));
    expect(reported[0]?.error).toBeInstanceOf(MonitoringTestError);
    expect(reported[0]?.context).toEqual({
      queue: queueNames.monitoringTest,
      jobName: 'fail',
      jobId: job.id,
      attempts: monitoringTestJobOptions.attempts,
      tenantId: TENANT,
    });
  });

  it('does not exist without testErrors, as in production', () => {
    expect(workers.workers.map((worker) => worker.name)).toContain(queueNames.monitoringTest);
    expect(production.workers.map((worker) => worker.name)).not.toContain(
      queueNames.monitoringTest,
    );
  });
});
