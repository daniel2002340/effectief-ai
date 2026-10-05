import { oc } from '@orpc/contract';
import { z } from 'zod';

export const testErrorInputSchema = z.object({
  /** `api` throws in the request; `worker` queues a job that fails on purpose. */
  target: z.enum(['api', 'worker']),
});

/**
 * Procedures that only exist outside production (decision #069). Separate
 * from `contract`, so the production router does not contain them at all.
 */
export const testContract = {
  test: {
    /** Only for an owner. Answers 500 for `api`; for `worker` once the job is queued. */
    error: oc
      .route({ method: 'POST', path: '/test/error' })
      .input(testErrorInputSchema)
      .output(z.object({ status: z.literal('queued') })),
  },
};

export type TestContract = typeof testContract;
