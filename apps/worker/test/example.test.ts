import { randomUUID } from 'node:crypto';
import { createDatabase } from '@effectief/db';
import { defaultJobOptions, parseEnv, queueNames } from '@effectief/shared';
import { Queue, QueueEvents } from 'bullmq';
import { pino } from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { workerEnvSchema } from '../src/env.ts';
import { processExampleJob } from '../src/jobs/example.ts';
import { startWorkers } from '../src/worker.ts';

const env = parseEnv(workerEnvSchema, { ...process.env, LOG_LEVEL: 'silent' });
const log = pino({ level: 'silent' });
const TENANT = '00000000-0000-4000-8000-00000000000a';

describe('processExampleJob', () => {
  it('processes a valid payload', async () => {
    const result = await processExampleJob(
      { tenantId: TENANT, note: 'hallo' },
      { jobId: '1', log },
    );
    expect(result).toEqual({ tenantId: TENANT, length: 5 });
  });

  it('rejects a payload without tenant', async () => {
    await expect(processExampleJob({ note: 'hallo' }, { jobId: '1', log })).rejects.toThrow(
      ZodError,
    );
  });
});

describe('example queue (Valkey)', () => {
  // Own key prefix per run, so parallel runs and real queues are untouched.
  const prefix = `test-${randomUUID()}`;
  const connection = { url: env.REDIS_URL, maxRetriesPerRequest: null };
  const queue = new Queue(queueNames.example, { connection, prefix, defaultJobOptions });
  const events = new QueueEvents(queueNames.example, { connection, prefix });
  const database = createDatabase(env.DATABASE_URL);
  const workers = startWorkers({ connection, log, prefix, db: database.db, adapters: {} });

  afterAll(async () => {
    await Promise.all(workers.map((worker) => worker.close()));
    await database.close();
    await events.close();
    await queue.obliterate({ force: true });
    await queue.close();
  });

  it('runs a job end to end', async () => {
    await events.waitUntilReady();
    const job = await queue.add('example', { tenantId: TENANT, note: 'test' });
    const result = await job.waitUntilFinished(events, 10_000);
    expect(result).toEqual({ tenantId: TENANT, length: 4 });
  });

  it('keeps a failed job instead of dropping it', async () => {
    const job = await queue.add('example', { note: 'no tenant' }, { attempts: 1 });
    await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow();
    expect(await queue.getJobState(job.id as string)).toBe('failed');
  });
});
