import { MonitoringTestError, type MonitoringTestJob, testContract } from '@effectief/shared';
import { ORPCError } from '@orpc/server';
import { createBuilders, type SessionResolver } from './builders.ts';

/** Puts a job on the monitoring-test queue; the worker fails it on purpose. */
export type EnqueueMonitoringTest = (job: MonitoringTestJob) => Promise<void>;

/**
 * Test errors for checking monitoring end to end (decision #069). Only
 * mounted outside production, and only for an owner: anyone else gets 403.
 */
export function createTestRouter(
  resolveSession: SessionResolver,
  enqueueMonitoringTest: EnqueueMonitoringTest,
) {
  const { procedure, router } = createBuilders(testContract, resolveSession);
  return router({
    test: {
      error: procedure.test.error.handler(async ({ context, input }) => {
        if (context.session.role !== 'owner') throw new ORPCError('FORBIDDEN');
        if (input.target === 'api') throw new MonitoringTestError('api');
        await enqueueMonitoringTest({ tenantId: context.session.tenantId });
        return { status: 'queued' as const };
      }),
    },
  });
}
