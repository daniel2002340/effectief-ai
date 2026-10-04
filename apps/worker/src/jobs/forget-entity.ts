import { type Database, type ForgetResult, forgetEntity, withTenant } from '@effectief/db';
import { forgetEntityJobSchema } from '@effectief/shared';
import type { Logger } from 'pino';

/**
 * Forgets a person on request of an owner (docs/data-model.md §6.3), in one
 * transaction. The caller checked the role. A repeat finds nothing to do.
 */
export async function processForgetEntityJob(
  data: unknown,
  job: { jobId: string },
  { db, log }: { db: Database; log: Logger },
): Promise<ForgetResult | null> {
  const { tenantId, entityId, requestedByUserId } = forgetEntityJobSchema.parse(data);
  const result = await withTenant(db, tenantId, (tx) =>
    forgetEntity(tx, {
      entityId,
      actor: { type: 'user', userId: requestedByUserId },
      context: { jobId: job.jobId },
    }),
  );
  // Ids and counts only; the entity's name is gone and must not be logged.
  log.info({ jobId: job.jobId, tenantId, entityId, deleted: result }, 'entity forgotten');
  return result;
}
