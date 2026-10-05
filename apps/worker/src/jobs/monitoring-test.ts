import { MonitoringTestError, monitoringTestJobSchema } from '@effectief/shared';
import type { Logger } from 'pino';

/**
 * Fails on purpose, on every attempt, to check monitoring end to end
 * (decision #069). Only started outside production.
 */
export async function processMonitoringTestJob(
  data: unknown,
  { jobId, log }: { jobId: string; log: Logger },
): Promise<never> {
  const job = monitoringTestJobSchema.parse(data);
  log.info({ jobId, tenantId: job.tenantId }, 'monitoring test job failing on purpose');
  throw new MonitoringTestError('worker');
}
