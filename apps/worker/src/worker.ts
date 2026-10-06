import type { Database } from '@effectief/db';
import type { AdapterRegistry } from '@effectief/integrations';
import type { NangoClient } from '@effectief/integrations/nango';
import {
  connectionSweepJobNames,
  defaultJobOptions,
  type MailIngestJob,
  mailIngestDeduplicationId,
  mailIngestJobNames,
  purgeConnectionJobId,
  queueNames,
  type ReportError,
  retentionJobNames,
  tenantIdOf,
} from '@effectief/shared';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';
import type { Logger } from 'pino';
import { handleAuthWebhook, type LifecycleDependencies } from './connections/lifecycle.ts';
import {
  processConnectAttemptJob,
  processConnectionSweep,
  processTenantAttempts,
  processTenantHealth,
} from './jobs/connections.ts';
import { processExampleJob } from './jobs/example.ts';
import { processExecuteActionJob } from './jobs/execute-action.ts';
import { processForgetEntityJob } from './jobs/forget-entity.ts';
import {
  processMailIngestJob,
  processMailIngestSweep,
  processMailIngestTenant,
} from './jobs/mail-ingest.ts';
import { processMonitoringTestJob } from './jobs/monitoring-test.ts';
import { processNangoWebhookJob } from './jobs/nango-webhook.ts';
import { processPurgeConnectionJob } from './jobs/purge-connection.ts';
import { processRetentionSweep, processRetentionTenantJob } from './jobs/retention.ts';

export interface StartWorkersOptions {
  connection: ConnectionOptions;
  log: Logger;
  /** As app_runtime; customer data only via withTenant(). */
  db: Database;
  /** Provider adapters for executing actions; tests pass a fake provider. */
  adapters: AdapterRegistry;
  /** Nango with the worker's key; tests pass a fake. */
  nango: NangoClient;
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
  /** The queue of the connection sweeps (attempts, health). */
  connectionSweepQueue: Queue;
  /** The mail-ingest queue, with its 10-minute sweep. */
  mailIngestQueue: Queue;
  /** Waits for running jobs, then closes workers and queues. */
  close: () => Promise<void>;
}

export function startWorkers({
  connection,
  log,
  db,
  adapters,
  nango,
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
    (job) => processPurgeConnectionJob(job.data, { jobId: jobIdOf(job) }, { db, log, nango }),
    { ...options, concurrency: 1 },
  );
  const purgeQueue = new Queue(queueNames.purgeConnection, {
    connection,
    defaultJobOptions,
    ...prefixOption,
  });
  const lifecycle: LifecycleDependencies = {
    db,
    nango,
    log,
    enqueuePurge: async (job) => {
      await purgeQueue.add('purge', job, { jobId: purgeConnectionJobId(job.connectionId) });
    },
  };
  const mailIngestQueue = new Queue(queueNames.mailIngest, {
    connection,
    defaultJobOptions,
    ...prefixOption,
  });
  const enqueueIngest = async (jobs: MailIngestJob[]) => {
    await mailIngestQueue.addBulk(
      jobs.map((job) => ({
        name: mailIngestJobNames.connection,
        data: job,
        opts: { deduplication: { id: mailIngestDeduplicationId(job) } },
      })),
    );
  };
  const mailIngest = new Worker(
    queueNames.mailIngest,
    (job) => {
      const info = { jobId: jobIdOf(job) };
      switch (job.name) {
        case mailIngestJobNames.sweep:
          return processMailIngestSweep(job.data, {
            db,
            enqueueTenants: async (tenantIds) => {
              // One per tenant per sweep run; the run's own id keeps them apart.
              await mailIngestQueue.addBulk(
                tenantIds.map((tenantId) => ({
                  name: mailIngestJobNames.tenant,
                  data: { tenantId },
                  opts: { jobId: `mail-ingest-tenant-${tenantId}-${info.jobId}` },
                })),
              );
            },
          });
        case mailIngestJobNames.tenant:
          return processMailIngestTenant(job.data, { db, enqueueIngest });
        default:
          return processMailIngestJob(job.data, info, { db, nango, log });
      }
    },
    options,
  );
  const nangoWebhook = new Worker(
    queueNames.nangoWebhook,
    (job) =>
      processNangoWebhookJob(
        job.data,
        { jobId: jobIdOf(job) },
        {
          db,
          log,
          handlers: {
            auth: ({ tenantId, delivery, payload, jobId, commit }) =>
              payload.type === 'auth'
                ? handleAuthWebhook(lifecycle, {
                    tenantId,
                    connectionId: delivery.connectionId,
                    connectAttemptId: delivery.connectAttemptId,
                    payload,
                    jobId,
                    commit,
                  })
                : Promise.resolve(),
            // A sync webhook is only a signal (§4.1): the ingest reads the
            // records. Enqueued before the commit; a failed commit retries
            // and the ingest is idempotent.
            sync: async ({ tenantId, delivery, payload, commit }) => {
              if (
                payload.type === 'sync' &&
                payload.success &&
                payload.model === 'InboxMessage' &&
                delivery.connectionId
              ) {
                await enqueueIngest([{ tenantId, connectionId: delivery.connectionId }]);
              } else if (payload.type === 'sync' && !payload.success) {
                // No status change: an auth problem comes through auth/refresh (§4.1).
                log.warn(
                  { tenantId, deliveryId: delivery.id, errorType: payload.error?.type },
                  'nango sync failed',
                );
              }
              await commit(async () => {});
            },
          },
        },
      ),
    options,
  );
  const connectAttempt = new Worker(
    queueNames.connectAttempt,
    (job) => processConnectAttemptJob(job.data, { jobId: jobIdOf(job) }, lifecycle),
    options,
  );
  const connectionSweepQueue = new Queue(queueNames.connectionSweep, {
    connection,
    defaultJobOptions,
    ...prefixOption,
  });
  const connectionSweep = new Worker(
    queueNames.connectionSweep,
    (job) => {
      const info = { jobId: jobIdOf(job) };
      switch (job.name) {
        case connectionSweepJobNames.tenantAttempts:
          return processTenantAttempts(job.data, info, lifecycle);
        case connectionSweepJobNames.tenantHealth:
          return processTenantHealth(job.data, info, lifecycle);
        default:
          return processConnectionSweep(job.name, job.data, {
            db,
            enqueueTenants: async (jobs) => {
              // One per tenant per sweep run; the run's own id keeps them apart.
              await connectionSweepQueue.addBulk(
                jobs.map(({ name, tenantId }) => ({
                  name,
                  data: { tenantId },
                  opts: { jobId: `${name}-${tenantId}-${info.jobId}` },
                })),
              );
            },
          });
      }
    },
    // One at a time: each run calls Nango per attempt or connection (rate limits, §4.3).
    { ...options, concurrency: 1 },
  );
  const workers = [
    example,
    executeAction,
    retention,
    forgetEntity,
    purgeConnection,
    nangoWebhook,
    connectAttempt,
    connectionSweep,
    mailIngest,
  ];
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
    connectionSweepQueue,
    mailIngestQueue,
    close: async () => {
      // close() waits for running jobs to finish.
      await Promise.all(workers.map((worker) => worker.close()));
      await Promise.all([
        retentionQueue.close(),
        purgeQueue.close(),
        connectionSweepQueue.close(),
        mailIngestQueue.close(),
      ]);
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
