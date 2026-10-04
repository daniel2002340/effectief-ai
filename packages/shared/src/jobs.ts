import { z } from 'zod';

/** Every job payload carries its tenant (CLAUDE.md, tenant isolation). */
const tenantJobSchema = z.object({
  tenantId: z.uuid(),
});

export const queueNames = {
  example: 'example',
  executeAction: 'execute-action',
  retention: 'retention',
  forgetEntity: 'forget-entity',
  purgeConnection: 'purge-connection',
} as const;

export const exampleJobSchema = tenantJobSchema.extend({
  note: z.string().min(1).max(500),
});
export type ExampleJob = z.infer<typeof exampleJobSchema>;

/**
 * Executes one approved action through its adapter. Starting the job never
 * bypasses approval: the job only claims an action that is `approved`.
 */
export const executeActionJobSchema = tenantJobSchema.extend({
  actionId: z.uuid(),
});
export type ExecuteActionJob = z.infer<typeof executeActionJobSchema>;

/**
 * One job per approval: a second enqueue for the same approval is ignored by
 * BullMQ. A retry after a failure is a new approval, so a new job.
 */
export const executeActionJobId = (actionId: string, approvedAt: Date) =>
  `execute-${actionId}-${approvedAt.getTime()}`;

/**
 * Retention (#037) runs as two jobs in one queue. `sweep` is the one job
 * without a tenant: it only lists tenant ids (list_tenant_ids()) and enqueues
 * one `tenant` job per tenant, which does the work within withTenant().
 */
export const retentionJobNames = { sweep: 'sweep', tenant: 'tenant' } as const;
export const retentionSweepJobSchema = z.strictObject({});
export const retentionTenantJobSchema = tenantJobSchema;
export type RetentionTenantJob = z.infer<typeof retentionTenantJobSchema>;

/** One retention job per tenant per day, also when the sweep runs twice. */
export const retentionTenantJobId = (tenantId: string, day: Date) =>
  `retention-${tenantId}-${day.toISOString().slice(0, 10)}`;

/** Forgetting a person on request of an owner (docs/data-model.md §6.3). */
export const forgetEntityJobSchema = tenantJobSchema.extend({
  entityId: z.uuid(),
  requestedByUserId: z.uuid(),
});
export type ForgetEntityJob = z.infer<typeof forgetEntityJobSchema>;

/** Deletes the data of a revoked connection and marks it purged. */
export const purgeConnectionJobSchema = tenantJobSchema.extend({
  connectionId: z.uuid(),
});
export type PurgeConnectionJob = z.infer<typeof purgeConnectionJobSchema>;

/** Retries with backoff; failed jobs are kept so no failure disappears silently. */
export const defaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
  removeOnFail: false,
} as const;
