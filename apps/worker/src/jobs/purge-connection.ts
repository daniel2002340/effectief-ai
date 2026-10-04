import { type Database, purgeConnection, TransitionError, withTenant } from '@effectief/db';
import { type ConnectionPurgeCounts, purgeConnectionJobSchema } from '@effectief/shared';
import { UnrecoverableError } from 'bullmq';
import type { Logger } from 'pino';

/**
 * Deletes the data of a revoked connection and marks it purged. A connection
 * that is still active is a bug in the caller: the job fails at once, without
 * retries, and stays visible as failed.
 */
export async function processPurgeConnectionJob(
  data: unknown,
  job: { jobId: string },
  { db, log }: { db: Database; log: Logger },
): Promise<{ purged: boolean; deleted?: ConnectionPurgeCounts }> {
  const { tenantId, connectionId } = purgeConnectionJobSchema.parse(data);
  try {
    const result = await withTenant(db, tenantId, (tx) =>
      purgeConnection(tx, {
        connectionId,
        actor: { type: 'system' },
        context: { jobId: job.jobId },
      }),
    );
    log.info(
      {
        jobId: job.jobId,
        tenantId,
        connectionId,
        ...(result.purged ? { deleted: result.deleted } : {}),
      },
      result.purged ? 'connection purged' : 'connection already purged or unknown',
    );
    return result.purged ? { purged: true, deleted: result.deleted } : { purged: false };
  } catch (error) {
    if (error instanceof TransitionError) {
      throw new UnrecoverableError(`purge refused: ${error.code}`);
    }
    throw error;
  }
}
