import type { Database } from '@effectief/db';
import type { AdapterRegistry } from '@effectief/integrations';
import {
  defaultJobOptions,
  queueNames,
  type ReportError,
  retentionJobNames,
  tenantIdOf,
} from '@effectief/shared';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';
import type { Logger } from 'pino';
import { processExampleJob } from './jobs/example.ts';
import { processExecuteActionJob } from './jobs/execute-action.ts';
import { processForgetEntityJob } from './jobs/forget-entity.ts';
import { processMonitoringTestJob } from './jobs/monitoring-test.ts';
import { processPurgeConnectionJob } from './jobs/purge-connection.ts';
import { processRetentionSweep, processRetentionTenantJob } from './jobs/retention.ts';

export interface StartWorkersOptions {
  connection: ConnectionOptions;
  log: Logger;
  /** As app_runtime; customer data only via withTenant(). */
  db: Database;
  /** Provider adapters for executing actions; tests pass a fake provider. */
  adapters: AdapterRegistry;
  /** Key prefix in Valkey; tests use their own to stay isolated. */
  prefix?: string;
  /** Sends jobs that failed for good to monitoring; IDs only (decision #055). */
  reportError: ReportError;
  /** Also run the job that fails on purpose; never in production (decision #069). */
  testErrors: boolean;
}

export interface StartedWorkers {
  workers: Worker[];
  /** The retention queue, which the sweep adds per-tenant jobs to. */
  retentionQueue: Queue;
  /** Waits for running jobs, then closes workers and queues. */
  close: () => Promise<void>;
}

export function startWorkers({
  connection,
  log,
  db,
  adapters,
  prefix,
  reportError,
  testErrors,
}: StartWorkersOptions): StartedWorkers {
  const prefixOption = prefix ? { prefix } : {};
  const options = { connection, concurrency: 5, ...prefixOption };
  const jobIdOf = (job: { id?: string | undefined; name: string; timestamp: number }) =>
    job.id ?? `${job.name}-${job.timestamp}`;
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
          jobId: jobIdOf(job),
          attemptsMade: job.attemptsMade,
          maxAttempts: job.opts.attempts ?? 1,
        },
        { db, adapters, log },
      ),
    options,
  );
  const retentionQueue = new Queue(queueNames.retention, {
    connection,
    defaultJobOptions,
    ...prefixOption,
  });
  const retention = new Worker(
    queueNames.retention,
    (job) => {
      if (job.name === retentionJobNames.sweep) {
        return processRetentionSweep(job.data, {
          db,
          log,
          enqueueTenants: async (jobs) => {
            await retentionQueue.addBulk(
              jobs.map(({ tenantId, jobId }) => ({
                name: retentionJobNames.tenant,
                data: { tenantId },
                opts: { jobId },
              })),
            );
          },
        });
      }
      return processRetentionTenantJob(job.data, { jobId: jobIdOf(job) }, { db, log });
    },
    options,
  );
  // One at a time: forgetting and purging delete a lot in one transaction.
  const forgetEntity = new Worker(
    queueNames.forgetEntity,
    (job) => processForgetEntityJob(job.data, { jobId: jobIdOf(job) }, { db, log }),
    { ...options, concurrency: 1 },
  );
  const purgeConnection = new Worker(
    queueNames.purgeConnection,
    (job) => processPurgeConnectionJob(job.data, { jobId: jobIdOf(job) }, { db, log }),
    { ...options, concurrency: 1 },
  );
  const workers = [example, executeAction, retention, forgetEntity, purgeConnection];
  if (testErrors) {
    workers.push(
      new Worker(
        queueNames.monitoringTest,
        (job) => processMonitoringTestJob(job.data, { jobId: jobIdOf(job), log }),
        options,
      ),
    );
  }

  for (const worker of workers) {
    worker.on('failed', (job, error) => {
      log.error(
        { queue: worker.name, jobId: job?.id, attempt: job?.attemptsMade, err: error },
        'job failed',
      );
      // Retries are expected; only the last failed attempt is worth an alert.
      if (!job || job.attemptsMade >= (job.opts.attempts ?? 1)) {
        reportError(error, failedJobContext(worker.name, job));
      }
    });
    worker.on('error', (error) => {
      log.error({ queue: worker.name, err: error }, 'worker error');
      reportError(error, { queue: worker.name });
    });
  }

  return {
    workers,
    retentionQueue,
    close: async () => {
      // close() waits for running jobs to finish.
      await Promise.all(workers.map((worker) => worker.close()));
      await retentionQueue.close();
    },
  };
}

/**
 * What monitoring gets about a job that failed for good: identifiers only,
 * never the payload (decision #055). The tenant comes from the payload as
 * parsed by Zod; a payload without a valid one reports none.
 */
export function failedJobContext(
  queue: string,
  job: { id?: string | undefined; name: string; attemptsMade: number; data: unknown } | undefined,
): Record<string, string | number | undefined> {
  if (!job) return { queue };
  return {
    queue,
    jobName: job.name,
    jobId: job.id,
    attempts: job.attemptsMade,
    tenantId: tenantIdOf(job.data),
  };
}
