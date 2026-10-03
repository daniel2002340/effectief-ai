import { type ExampleJob, exampleJobSchema } from '@effectief/shared';
import type { Logger } from 'pino';

export interface JobContext {
  jobId: string | undefined;
  log: Logger;
}

/** Example processor: validates the payload and logs IDs only, never content. */
export async function processExampleJob(
  data: unknown,
  { jobId, log }: JobContext,
): Promise<{ tenantId: string; length: number }> {
  const job: ExampleJob = exampleJobSchema.parse(data);
  log.info({ jobId, tenantId: job.tenantId }, 'example job processed');
  return { tenantId: job.tenantId, length: job.note.length };
}
