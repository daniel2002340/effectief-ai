import type { AuditContext, ConnectionProvider } from '@effectief/shared';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { cards, connections } from '../schema/index.ts';
import type { TenantTransaction } from '../with-tenant.ts';
import { writeAudit } from './audit.ts';
import { createCard, transitionCard } from './cards.ts';
import { type Connection, getConnection, transitionConnection } from './connections.ts';

// What happens to a connection when its grant stops or starts working again
// (docs/integrations.md §5, #077): a status change through transitionConnection()
// plus the card "Koppeling vernieuwen", in the caller's transaction. Never
// retried against the provider: the user re-authorizes.

const system = { type: 'system' } as const;

export const providerNames: Record<ConnectionProvider, string> = {
  gmail: 'Gmail',
  outlook: 'Outlook',
  moneybird: 'Moneybird',
  mollie: 'Mollie',
};

const problemKey = (connectionId: string) => `connection:${connectionId}`;

/**
 * The grant no longer works (`invalid_grant`), or it reads another account
 * than the one connected (`account_mismatch`): an active connection expires,
 * and an active or expired one gets one open problem card. Returns the
 * connection, or undefined when it does not exist for this tenant.
 */
export async function expireConnection(
  tx: TenantTransaction,
  input: {
    connectionId: string;
    reason: 'invalid_grant' | 'account_mismatch';
    context?: AuditContext | undefined;
  },
): Promise<Connection | undefined> {
  const connection = await getConnection(tx, input.connectionId);
  if (!connection || (connection.status !== 'active' && connection.status !== 'expired')) {
    return connection;
  }
  const current =
    connection.status === 'active'
      ? await transitionConnection(tx, {
          connectionId: connection.id,
          from: 'active',
          to: 'expired',
          reason: input.reason,
          actor: system,
          context: input.context,
        })
      : connection;
  await createCard(tx, {
    kind: 'connection_problem',
    connectionId: connection.id,
    title: `Koppeling met ${providerNames[connection.provider]} opnieuw maken`,
    payload: { reason: input.reason },
    priority: 3,
    dedupeKey: problemKey(connection.id),
    actor: system,
    context: input.context,
  });
  return current;
}

/**
 * The grant works again for the same account: an expired connection becomes
 * active and its problem card is closed. An active one gets an audit entry
 * only (`reauthorized`), as the user re-authorized without a problem.
 */
export async function reactivateConnection(
  tx: TenantTransaction,
  input: {
    connectionId: string;
    reason: 'reauthorized' | 'auth_recovered';
    context?: AuditContext | undefined;
  },
): Promise<Connection | undefined> {
  const connection = await getConnection(tx, input.connectionId);
  if (!connection) return undefined;
  if (connection.status === 'active') {
    if (input.reason === 'reauthorized') {
      await writeAudit(tx, {
        actor: system,
        context: input.context,
        action: 'connection.reauthorized',
        objectType: 'connections',
        objectId: connection.id,
        metadata: { provider: connection.provider, reason: 'reauthorized' },
      });
    }
    return connection;
  }
  if (connection.status !== 'expired') return connection;
  const active = await transitionConnection(tx, {
    connectionId: connection.id,
    from: 'expired',
    to: 'active',
    reason: input.reason,
    actor: system,
    context: input.context,
  });
  await closeConnectionProblem(tx, connection.id, input.context);
  return active;
}

/** Closes the open (or snoozed) problem card of a connection, if any. */
async function closeConnectionProblem(
  tx: TenantTransaction,
  connectionId: string,
  context: AuditContext | undefined,
) {
  const open = await tx
    .select({ id: cards.id, status: cards.status })
    .from(cards)
    .where(
      and(
        eq(cards.dedupeKey, problemKey(connectionId)),
        inArray(cards.status, ['open', 'snoozed']),
      ),
    );
  for (const card of open) {
    if (card.status !== 'open' && card.status !== 'snoozed') continue;
    await transitionCard(tx, {
      cardId: card.id,
      from: card.status,
      to: 'done',
      actor: system,
      context,
    });
  }
}

/** A connection by its Nango ID, within the tenant. */
export async function getConnectionByNangoId(tx: TenantTransaction, nangoConnectionId: string) {
  const [row] = await tx
    .select()
    .from(connections)
    .where(eq(connections.nangoConnectionId, nangoConnectionId));
  return row;
}

/**
 * A connection of this tenant to the same provider account that still counts:
 * active, or expired (the user renews that one instead of connecting anew, so
 * the mailbox's mail never belongs to two connections).
 */
export async function findLiveAccountConnection(
  tx: TenantTransaction,
  provider: ConnectionProvider,
  externalAccountId: string,
) {
  const [row] = await tx
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.provider, provider),
        eq(connections.externalAccountId, externalAccountId),
        inArray(connections.status, ['active', 'expired']),
      ),
    );
  return row;
}

/**
 * Whether an earlier, disconnected connection to the same account still waits
 * for its purge. Its events carry the same provider IDs: a new connection that
 * took them in now would find them taken, and lose them when the purge runs.
 */
export async function isAccountAwaitingPurge(
  tx: TenantTransaction,
  connection: Pick<Connection, 'id' | 'provider' | 'externalAccountId'>,
): Promise<boolean> {
  if (!connection.externalAccountId) return false;
  const [row] = await tx
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.provider, connection.provider),
        eq(connections.externalAccountId, connection.externalAccountId),
        eq(connections.status, 'revoked'),
        ne(connections.id, connection.id),
      ),
    )
    .limit(1);
  return row !== undefined;
}
