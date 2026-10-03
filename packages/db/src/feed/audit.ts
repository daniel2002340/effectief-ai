import { type AuditEntryInput, auditEntrySchema, auditObjectTypes } from '@effectief/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { single } from '../memory/source.ts';
import { auditLog } from '../schema/index.ts';
import type { TenantTransaction } from '../with-tenant.ts';

export type AuditLogEntry = typeof auditLog.$inferSelect;

/**
 * Appends one entry to audit_log, in the caller's transaction so the entry
 * and the change it describes commit together. Metadata is parsed with the
 * schema of the action: IDs, codes and counts only.
 */
export async function writeAudit(tx: TenantTransaction, input: AuditEntryInput) {
  const { actor, context, metadata, ...entry } = auditEntrySchema.parse(input);
  return single(
    await tx
      .insert(auditLog)
      .values({
        ...entry,
        actorType: actor.type,
        actorUserId: actor.type === 'user' ? actor.userId : null,
        metadata,
        requestId: context.requestId ?? null,
        jobId: context.jobId ?? null,
      })
      .returning(),
  );
}

const auditQuerySchema = z.strictObject({
  objectType: z.enum(auditObjectTypes),
  objectId: z.uuid(),
});

/** The history of one object, oldest first. */
export function listAuditLog(tx: TenantTransaction, query: z.input<typeof auditQuerySchema>) {
  const { objectType, objectId } = auditQuerySchema.parse(query);
  return tx
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.objectType, objectType), eq(auditLog.objectId, objectId)))
    .orderBy(auditLog.occurredAt, auditLog.id);
}
