import {
  type Database,
  getConnection,
  purgeConnection,
  TransitionError,
  withTenant,
} from '@effectief/db';
import { type NangoClient, nangoProviders } from '@effectief/integrations/nango';
import { type ConnectionPurgeCounts, purgeConnectionJobSchema } from '@effectief/shared';
import { UnrecoverableError } from 'bullmq';
import type { Logger } from 'pino';

/**
 * Removes a revoked connection at Nango, then deletes the data that came in
 * through it and marks it purged (docs/integrations.md §5.3). Nothing is
 * purged until Nango confirms (or says it is already gone), so a failure is
 * retried from the start. A connection that is still active is a bug in the
 * caller: the job fails at once, without retries, and stays visible.
 */
export async function processPurgeConnectionJob(
  data: unknown,
  job: { jobId: string },
  { db, log, nango }: { db: Database; log: Logger; nango: NangoClient },
): Promise<{ purged: boolean; deleted?: ConnectionPurgeCounts }> {
  const { tenantId, connectionId } = purgeConnectionJobSchema.parse(data);
  const connection = await withTenant(db, tenantId, (tx) => getConnection(tx, connectionId));
  if (connection?.status === 'active') {
    throw new UnrecoverableError('purge refused: connection is active');
  }
  if (
    connection &&
    connection.status !== 'purged' &&
    (nangoProviders as string[]).includes(connection.provider)
  ) {
    // 404 counts as deleted; any other error retries the job.
    const { deleted } = await nango.deleteConnection({
      integrationId: connection.nangoIntegrationId,
      connectionId: connection.nangoConnectionId,
    });
    log.info({ jobId: job.jobId, tenantId, connectionId, atNango: deleted }, 'removed at nango');
  }
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
