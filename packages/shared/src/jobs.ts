import { z } from 'zod';

/** Every job payload carries its tenant (CLAUDE.md, tenant isolation). */
const tenantJobSchema = z.object({
  tenantId: z.uuid(),
});

export const queueNames = {
  example: 'example',
} as const;

export const exampleJobSchema = tenantJobSchema.extend({
  note: z.string().min(1).max(500),
});
export type ExampleJob = z.infer<typeof exampleJobSchema>;

/** Retries with backoff; failed jobs are kept so no failure disappears silently. */
export const defaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
  removeOnFail: false,
} as const;
