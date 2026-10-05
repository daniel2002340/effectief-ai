import { randomBytes } from 'node:crypto';
import {
  type AuditContext,
  type ConnectAttemptFailureCode,
  connectAttemptFailureCodes,
  connectionProviders,
} from '@effectief/shared';
import { and, asc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../client.ts';
import { single } from '../memory/source.ts';
import { connectAttempts } from '../schema/index.ts';
import type { TenantTransaction } from '../with-tenant.ts';
import { writeAudit } from './audit.ts';

// connect_attempts (docs/integrations.md §2.2, #075, #081): the key to which
// tenant a new Nango connection belongs. The tenant and member come from the
// session; the nonce goes to Nango as a tag and comes back in the creation
// webhook. Consumed once, in the transaction that creates the connection.

export type ConnectAttempt = typeof connectAttempts.$inferSelect;

/** How long the Nango connect session (and so the attempt) is usable. */
export const CONNECT_SESSION_MINUTES = 30;
/** After this, an open attempt no longer becomes a connection (§2.2 step 4). */
export const CONNECT_ATTEMPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const nonceSchema = z.string().regex(/^[0-9a-f]{64}$/);
const idSchema = z.uuid();

const createInputSchema = z.strictObject({
  provider: z.enum(connectionProviders),
  nangoIntegrationId: z.string().regex(/^[\w.:-]{1,200}$/),
  createdByUserId: z.uuid(),
});

/** Starts a flow for the session's tenant and member, with a fresh secret nonce. */
export async function createConnectAttempt(
  tx: TenantTransaction,
  input: z.input<typeof createInputSchema>,
): Promise<ConnectAttempt> {
  const values = createInputSchema.parse(input);
  return single(
    await tx
      .insert(connectAttempts)
      .values({
        ...values,
        nonce: randomBytes(32).toString('hex'),
        expiresAt: sql`now() + make_interval(mins => ${CONNECT_SESSION_MINUTES})`,
      })
      .returning(),
  );
}

export async function getConnectAttempt(tx: TenantTransaction, attemptId: string) {
  const [row] = await tx
    .select()
    .from(connectAttempts)
    .where(eq(connectAttempts.id, idSchema.parse(attemptId)));
  return row;
}

/** The attempt, locked until the end of the transaction: one consumer at a time. */
export async function lockConnectAttempt(tx: TenantTransaction, attemptId: string) {
  const [row] = await tx
    .select()
    .from(connectAttempts)
    .where(eq(connectAttempts.id, idSchema.parse(attemptId)))
    .for('update');
  return row;
}

/** Open and younger than a day: may still become a connection. */
export function isOpenConnectAttempt(attempt: ConnectAttempt, now = new Date()): boolean {
  return (
    attempt.consumedAt === null &&
    now.getTime() - attempt.createdAt.getTime() < CONNECT_ATTEMPT_MAX_AGE_MS
  );
}

/** The attempt became this connection. Only from open; returns false otherwise. */
export async function consumeConnectAttempt(
  tx: TenantTransaction,
  input: { attemptId: string; connectionId: string; nangoConnectionId: string },
): Promise<boolean> {
  const rows = await tx
    .update(connectAttempts)
    .set({
      consumedAt: sql`now()`,
      connectionId: idSchema.parse(input.connectionId),
      nangoConnectionId: input.nangoConnectionId,
    })
    .where(
      and(
        eq(connectAttempts.id, idSchema.parse(input.attemptId)),
        isNull(connectAttempts.consumedAt),
      ),
    )
    .returning({ id: connectAttempts.id });
  return rows.length === 1;
}

/**
 * The attempt did not become a connection; closes it with a code and one
 * audit entry. Only from open; returns false when it was closed already.
 */
export async function failConnectAttempt(
  tx: TenantTransaction,
  input: {
    attemptId: string;
    failureCode: ConnectAttemptFailureCode;
    nangoConnectionId?: string | undefined;
    context?: AuditContext | undefined;
  },
): Promise<boolean> {
  const failureCode = z.enum(connectAttemptFailureCodes).parse(input.failureCode);
  const [row] = await tx
    .update(connectAttempts)
    .set({
      consumedAt: sql`now()`,
      failureCode,
      ...(input.nangoConnectionId ? { nangoConnectionId: input.nangoConnectionId } : {}),
    })
    .where(
      and(
        eq(connectAttempts.id, idSchema.parse(input.attemptId)),
        isNull(connectAttempts.consumedAt),
      ),
    )
    .returning();
  if (!row) return false;
  await writeAudit(tx, {
    actor: { type: 'system' },
    context: input.context,
    action: 'connect_attempt.rejected',
    objectType: 'connect_attempts',
    objectId: row.id,
    metadata: { provider: row.provider, failureCode },
  });
  return true;
}

/** Open attempts created in a window, oldest first, for the sweep (§2.3, §4.6). */
export function listOpenConnectAttempts(
  tx: TenantTransaction,
  window: { createdAfter?: Date; createdBefore: Date },
) {
  return tx
    .select()
    .from(connectAttempts)
    .where(
      and(
        isNull(connectAttempts.consumedAt),
        lt(connectAttempts.createdAt, window.createdBefore),
        window.createdAfter ? gt(connectAttempts.createdAt, window.createdAfter) : undefined,
      ),
    )
    .orderBy(asc(connectAttempts.createdAt))
    .limit(100);
}

/**
 * The tenant of a creation webhook, through the SECURITY DEFINER function
 * resolve_connect_attempt() (migration 0019). Outside withTenant(): the
 * webhook does not know its tenant yet. Ids only; undefined for a nonce that
 * is not ours (or not a nonce at all).
 */
export async function resolveConnectAttempt(
  db: Database,
  nonce: string,
): Promise<{ tenantId: string; attemptId: string } | undefined> {
  if (!nonceSchema.safeParse(nonce).success) return undefined;
  const { rows } = await db.execute<{ tenant_id: string; attempt_id: string }>(
    sql`select tenant_id, attempt_id from public.resolve_connect_attempt(${nonce})`,
  );
  const [row] = rows;
  return row ? { tenantId: row.tenant_id, attemptId: row.attempt_id } : undefined;
}
