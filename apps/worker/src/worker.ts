import type { Database } from '@effectief/db';
import type { AdapterRegistry } from '@effectief/integrations';
import { queueNames } from '@effectief/shared';
import { type ConnectionOptions, Worker } from 'bullmq';
import type { Logger } from 'pino';
import { processExampleJob } from './jobs/example.ts';
import { processExecuteActionJob } from './jobs/execute-action.ts';

export interface StartWorkersOptions {
  connection: ConnectionOptions;
  log: Logger;
  /** As app_runtime; customer data only via withTenant(). */
  db: Database;
  /** Provider adapters for executing actions; tests pass a fake provider. */
  adapters: AdapterRegistry;
  /** Key prefix in Valkey; tests use their own to stay isolated. */
  prefix?: string;
}

export function startWorkers({
  connection,
  log,
  db,
  adapters,
  prefix,
}: StartWorkersOptions): Worker[] {
  const options = { connection, concurrency: 5, ...(prefix ? { prefix } : {}) };
  const example = new Worker(
    queueNames.example,
    (job) => processExampleJob(job.data, { jobId: job.id, log }),
    options,
  );
  const executeAction = new Worker(
    queueNames.executeAction,
    (job) =>
      processExecuteActionJob(
        job.data,
        {
          jobId: job.id ?? `${job.name}-${job.timestamp}`,
          attemptsMade: job.attemptsMade,
          maxAttempts: job.opts.attempts ?? 1,
        },
        { db, adapters, log },
      ),
    options,
  );
  const workers = [example, executeAction];

  for (const worker of workers) {
    worker.on('failed', (job, error) => {
      log.error(
        { queue: worker.name, jobId: job?.id, attempt: job?.attemptsMade, err: error },
        'job failed',
      );
    });
    worker.on('error', (error) => log.error({ queue: worker.name, err: error }, 'worker error'));
  }

  return workers;
}
