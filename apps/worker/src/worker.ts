import { queueNames } from '@effectief/shared';
import { type ConnectionOptions, Worker } from 'bullmq';
import type { Logger } from 'pino';
import { processExampleJob } from './jobs/example.ts';

export interface StartWorkersOptions {
  connection: ConnectionOptions;
  log: Logger;
  /** Key prefix in Valkey; tests use their own to stay isolated. */
  prefix?: string;
}

export function startWorkers({ connection, log, prefix }: StartWorkersOptions): Worker[] {
  const example = new Worker(
    queueNames.example,
    (job) => processExampleJob(job.data, { jobId: job.id, log }),
    { connection, concurrency: 5, ...(prefix ? { prefix } : {}) },
  );

  for (const worker of [example]) {
    worker.on('failed', (job, error) => {
      log.error(
        { queue: worker.name, jobId: job?.id, attempt: job?.attemptsMade, err: error },
        'job failed',
      );
    });
    worker.on('error', (error) => log.error({ queue: worker.name, err: error }, 'worker error'));
  }

  return [example];
}
