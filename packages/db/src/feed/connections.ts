import {
  type AddEntityExternalRefInput,
  addEntityExternalRefInputSchema,
  type ConnectionStatus,
  type CreateConnectionInput,
  connectionAuditActions,
  connectionStatuses,
  connectionTransitions,
  createConnectionInputSchema,
  type TransitionConnectionInput,
  transitionConnectionInputSchema,
} from '@effectief/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { single } from '../memory/source.ts';
import { connections, entityExternalRefs } from '../schema/index.ts';
import type { TenantTransaction } from '../with-tenant.ts';
import { writeAudit } from './audit.ts';
import { assertTransition, missedTransition } from './transition.ts';

export type Connection = typeof connections.$inferSelect;
export type EntityExternalRef = typeof entityExternalRefs.$inferSelect;

const idSchema = z.uuid();

/**
 * Records a connection the session's tenant just made through a Nango connect
 * session (CLAUDE.md, authentication). Starts `active`.
 */
export async function createConnection(tx: TenantTransaction, input: CreateConnectionInput) {
  const { actor, context, ...values } = createConnectionInputSchema.parse(input);
  const connection = single(await tx.insert(connections).values(values).returning());
  await writeAudit(tx, {
    actor,
    context,
    action: 'connection.created',
    objectType: 'connections',
    objectId: connection.id,
    toStatus: connection.status,
    metadata: { provider: connection.provider },
  });
  return connection;
}

/**
 * The only way to change a connection's status. Refuses transitions outside
 * connectionTransitions, and applies only if the status is still `from`
 * (atomic; a concurrent change makes this throw `status_changed`). Purging
 * clears the account label. Writes one audit entry in the same transaction.
 */
export async function transitionConnection(
  tx: TenantTransaction,
  input: TransitionConnectionInput,
) {
  const { connectionId, from, to, reason, actor, context } =
    transitionConnectionInputSchema.parse(input);
  assertTransition('connections', connectionTransitions, from, to);

  const [connection] = await tx
    .update(connections)
    .set({
      status: to,
      statusReason: reason,
      statusChangedAt: sql`now()`,
      ...(to === 'purged' ? { accountLabel: null } : {}),
    })
    .where(and(eq(connections.id, connectionId), eq(connections.status, from)))
    .returning();
  if (!connection) {
    throw await missedTransition(
      tx,
      { name: 'connections', table: connections, id: connections.id, status: connections.status },
      connectionId,
      from,
      to,
    );
  }

  await writeAudit(tx, {
    actor,
    context,
    action: connectionAuditActions[to],
    objectType: 'connections',
    objectId: connection.id,
    fromStatus: from,
    toStatus: to,
    metadata: { provider: connection.provider, reason },
  });
  return connection;
}

export async function getConnection(tx: TenantTransaction, connectionId: string) {
  const [row] = await tx
    .select()
    .from(connections)
    .where(eq(connections.id, idSchema.parse(connectionId)));
  return row;
}

export function listConnections(tx: TenantTransaction, status?: ConnectionStatus) {
  return tx
    .select()
    .from(connections)
    .where(status ? eq(connections.status, z.enum(connectionStatuses).parse(status)) : undefined)
    .orderBy(asc(connections.createdAt), asc(connections.id));
}

/**
 * Records who an entity is at a provider. Idempotent: a known reference
 * returns the existing row with `created: false`. The provider is taken from
 * the connection, so the two cannot disagree.
 */
export async function addEntityExternalRef(
  tx: TenantTransaction,
  input: AddEntityExternalRefInput,
) {
  const ref = addEntityExternalRefInputSchema.parse(input);
  const connection = await getConnection(tx, ref.connectionId);
  if (!connection) throw new Error(`Connection ${ref.connectionId} not found`);

  const [created] = await tx
    .insert(entityExternalRefs)
    .values({ ...ref, provider: connection.provider })
    .onConflictDoNothing()
    .returning();
  if (created) return { ref: created, created: true };
  const existing = single(
    await tx
      .select()
      .from(entityExternalRefs)
      .where(
        and(
          eq(entityExternalRefs.connectionId, ref.connectionId),
          eq(entityExternalRefs.objectType, ref.objectType),
          eq(entityExternalRefs.externalId, ref.externalId),
        ),
      ),
  );
  return { ref: existing, created: false };
}

export function listEntityExternalRefs(tx: TenantTransaction, entityId: string) {
  return tx
    .select()
    .from(entityExternalRefs)
    .where(eq(entityExternalRefs.entityId, idSchema.parse(entityId)))
    .orderBy(asc(entityExternalRefs.createdAt));
}
