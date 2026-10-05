import { type Database, listTenantIds, purgeExpiredBatch, withTenant } from '@effectief/db';
import {
  defaultJobOptions,
  type RetentionStep,
  type RetentionTenantJob,
  retentionJobNames,
  retentionSteps,
  retentionSweepJobSchema,
  retentionTenantJobId,
  retentionTenantJobSchema,
} from '@effectief/shared';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';

// Retention (#037, docs/data-model.md event_contents): a daily sweep enqueues
// one job per tenant; that job deletes expired data within withTenant(), in
// batches, each batch its own transaction with its own audit entry.

/** Daily at 03:00 in the Netherlands. */
export const retentionSchedule = { pattern: '0 3 * * *', tz: 'Europe/Amsterdam' } as const;

const BATCH_SIZE = 1_000;

/** Idempotent: run at every worker start, updates the one scheduler. */
export function scheduleRetention(queue: Queue) {
  return queue.upsertJobScheduler('retention-sweep', retentionSchedule, {
    name: retentionJobNames.sweep,
    data: {},
    opts: defaultJobOptions,
  });
}

export interface RetentionDependencies {
  db: Database;
  log: Logger;
  /** Enqueues the per-tenant jobs; BullMQ ignores a job id it already has. */
  enqueueTenants: (jobs: { tenantId: string; jobId: string }[]) => Promise<void>;
  now?: () => Date;
}

/** The one job without a tenant: lists tenant ids, nothing else. */
export async function processRetentionSweep(
  data: unknown,
  { db, log, enqueueTenants, now = () => new Date() }: RetentionDependencies,
): Promise<{ tenants: number }> {
  retentionSweepJobSchema.parse(data);
  const day = now();
  const tenantIds = await listTenantIds(db);
  await enqueueTenants(
    tenantIds.map((tenantId) => ({ tenantId, jobId: retentionTenantJobId(tenantId, day) })),
  );
  log.info({ tenants: tenantIds.length }, 'retention sweep enqueued tenants');
  return { tenants: tenantIds.length };
}

export async function processRetentionTenantJob(
  data: unknown,
  job: { jobId: string },
  { db, log, now = () => new Date() }: Omit<RetentionDependencies, 'enqueueTenants'>,
): Promise<Record<RetentionStep, number>> {
  const { tenantId }: RetentionTenantJob = retentionTenantJobSchema.parse(data);
  const moment = now();
  const counts = { event_contents: 0, action_inputs: 0, closed_cards: 0, webhook_deliveries: 0 };
  for (const step of retentionSteps) {
    let batch: number;
    do {
      batch = await withTenant(db, tenantId, (tx) =>
        purgeExpiredBatch(tx, {
          step,
          now: moment,
          limit: BATCH_SIZE,
          context: { jobId: job.jobId },
        }),
      );
      counts[step] += batch;
    } while (batch === BATCH_SIZE);
  }
  log.info({ jobId: job.jobId, tenantId, ...counts }, 'retention done');
  return counts;
}
