import { z } from 'zod';

/** Every job payload carries its tenant (CLAUDE.md, tenant isolation). */
const tenantJobSchema = z.object({
  tenantId: z.uuid(),
});

export const queueNames = {
  example: 'example',
  executeAction: 'execute-action',
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

/** Retries with backoff; failed jobs are kept so no failure disappears silently. */
export const defaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
  removeOnFail: false,
} as const;
