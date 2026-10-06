import {
  type Connection,
  countReceivedMailByConnection,
  createConnectAttempt,
  type Database,
  disconnectConnection,
  getConnectAttempt,
  getConnection,
  isOpenConnectAttempt,
  listConnections,
  withTenant,
} from '@effectief/db';
import {
  NangoApiError,
  type NangoClient,
  nangoIntegrationIds,
} from '@effectief/integrations/nango';
import type {
  CompleteConnectOutput,
  ConnectAttemptJob,
  ConnectionSummary,
  MailProvider,
  PurgeConnectionJob,
} from '@effectief/shared';
import { ORPCError } from '@orpc/server';
import type { SessionContext } from '../auth/auth.ts';

// connections.* (docs/integrations.md §2.1): the tenant and member always come
// from the session. Nango's IDs and the attempt's nonce never leave the server.

export type EnqueueConnectAttempt = (job: ConnectAttemptJob) => Promise<void>;
export type EnqueuePurgeConnection = (job: PurgeConnectionJob) => Promise<void>;

export interface ConnectionHandlerDependencies {
  appDb: Database;
  /** With the api's key: connect sessions and listing connections by tag (§7.3). */
  nango: NangoClient;
  /** `none`, or the local tunnel URL (§7.4). */
  webhookUrlOverride: string;
  enqueueConnectAttempt: EnqueueConnectAttempt;
  enqueuePurgeConnection: EnqueuePurgeConnection;
}

interface CallContext {
  session: SessionContext;
  requestId: string;
  log: {
    warn: (object: object, message: string) => void;
    error: (object: object, message: string) => void;
  };
}

/** The member who connected it, or an owner (#080). */
const canManage = (session: SessionContext, connection: Connection) =>
  session.role === 'owner' || connection.connectedByUserId === session.userId;

const toSummary = (
  session: SessionContext,
  connection: Connection,
  receivedMailCount: number,
): ConnectionSummary => ({
  id: connection.id,
  provider: connection.provider,
  status: connection.status,
  statusReason: connection.statusReason,
  accountLabel: connection.accountLabel,
  lastSyncedAt: connection.lastSyncedAt,
  receivedMailCount,
  connectedAt: connection.createdAt,
  canManage: canManage(session, connection),
});

/** Nango down or refusing: the user sees "try again later", we see the code. */
function nangoUnavailable(log: CallContext['log'], error: unknown, operation: string): never {
  if (!(error instanceof NangoApiError)) throw error;
  log.error(
    { operation, kind: error.kind, status: error.status, code: error.code },
    'nango call failed',
  );
  throw new ORPCError('SERVICE_UNAVAILABLE');
}

export function connectionHandlers({
  appDb,
  nango,
  webhookUrlOverride,
  enqueueConnectAttempt,
  enqueuePurgeConnection,
}: ConnectionHandlerDependencies) {
  const override = webhookUrlOverride === 'none' ? undefined : webhookUrlOverride;

  /** A connection of the session's tenant that this member may manage; else NOT_FOUND or FORBIDDEN. */
  async function manageable(session: SessionContext, connectionId: string) {
    const connection = await withTenant(appDb, session.tenantId, (tx) =>
      getConnection(tx, connectionId),
    );
    if (!connection) throw new ORPCError('NOT_FOUND');
    if (!canManage(session, connection)) throw new ORPCError('FORBIDDEN');
    return connection;
  }

  return {
    async list({ session }: CallContext): Promise<ConnectionSummary[]> {
      const { rows, mailCounts } = await withTenant(appDb, session.tenantId, async (tx) => ({
        rows: await listConnections(tx),
        mailCounts: await countReceivedMailByConnection(tx),
      }));
      return rows
        .filter((row) => row.status !== 'purged')
        .map((row) => toSummary(session, row, mailCounts.get(row.id) ?? 0));
    },

    /**
     * Records the attempt for the session's tenant and member, then asks Nango
     * for a session carrying the attempt's nonce as a tag (§2.1, §2.2).
     */
    async startConnect(
      { session, log }: CallContext,
      input: { provider: MailProvider },
    ): Promise<{ sessionToken: string; attemptId: string }> {
      const { tenantId, userId } = session;
      const integrationId = nangoIntegrationIds[input.provider];
      const attempt = await withTenant(appDb, tenantId, (tx) =>
        createConnectAttempt(tx, {
          provider: input.provider,
          nangoIntegrationId: integrationId,
          createdByUserId: userId,
        }),
      );
      try {
        const connectSession = await nango.createConnectSession({
          integrationId,
          tags: { organization_id: tenantId, end_user_id: userId, connect_attempt: attempt.nonce },
          webhookUrlOverride: override,
        });
        return { sessionToken: connectSession.token, attemptId: attempt.id };
      } catch (error) {
        // The attempt stays open and unused; the sweep closes it after a day.
        return nangoUnavailable(log, error, 'create connect session');
      }
    },

    /**
     * Where the flow stands. While open, looks the connection up at Nango by
     * the tag our server set, never by anything the browser sends, and hands
     * it to the same job as the creation webhook (§2.3).
     */
    async complete(
      { session, log }: CallContext,
      input: { attemptId: string },
    ): Promise<CompleteConnectOutput> {
      const { tenantId, userId } = session;
      const attempt = await withTenant(appDb, tenantId, (tx) =>
        getConnectAttempt(tx, input.attemptId),
      );
      // Another tenant's attempt is invisible (RLS); another member's is not ours either.
      if (!attempt || attempt.createdByUserId !== userId) throw new ORPCError('NOT_FOUND');
      if (attempt.consumedAt) {
        return attempt.connectionId
          ? { status: 'connected', failureCode: null, connectionId: attempt.connectionId }
          : { status: 'failed', failureCode: attempt.failureCode, connectionId: null };
      }
      if (!isOpenConnectAttempt(attempt)) {
        return { status: 'failed', failureCode: 'expired', connectionId: null };
      }
      try {
        const found = (
          await nango.listConnectionsByTags({ connect_attempt: attempt.nonce })
        ).filter((connection) => connection.integrationId === attempt.nangoIntegrationId);
        const [only] = found;
        if (found.length === 1 && only) {
          await enqueueConnectAttempt({
            tenantId,
            attemptId: attempt.id,
            nangoConnectionId: only.connectionId,
          });
        } else if (found.length > 1) {
          log.warn(
            { tenantId, attemptId: attempt.id, found: found.length },
            'attempt has several Nango connections',
          );
        }
      } catch (error) {
        if (!(error instanceof NangoApiError)) throw error;
        // Still pending; the webhook or the sweep finishes it.
        log.warn(
          { tenantId, attemptId: attempt.id, kind: error.kind },
          'nango lookup for attempt failed',
        );
      }
      return { status: 'pending', failureCode: null, connectionId: null };
    },

    /** A reconnect session for an active or expired connection (§2.4). */
    async reconnect(
      { session, log }: CallContext,
      input: { connectionId: string },
    ): Promise<{ sessionToken: string }> {
      const connection = await manageable(session, input.connectionId);
      if (connection.status !== 'active' && connection.status !== 'expired') {
        throw new ORPCError('CONFLICT');
      }
      try {
        const reconnectSession = await nango.createReconnectSession({
          integrationId: connection.nangoIntegrationId,
          connectionId: connection.nangoConnectionId,
          webhookUrlOverride: override,
        });
        return { sessionToken: reconnectSession.token };
      } catch (error) {
        return nangoUnavailable(log, error, 'create reconnect session');
      }
    },

    /**
     * Revokes now; the purge job removes the connection at Nango first and
     * then the data that came in through it (§5.3). Idempotent.
     */
    async disconnect(
      { session, requestId, log }: CallContext,
      input: { connectionId: string },
    ): Promise<ConnectionSummary> {
      await manageable(session, input.connectionId);
      const { tenantId, userId } = session;
      const connection = await withTenant(appDb, tenantId, (tx) =>
        disconnectConnection(tx, {
          connectionId: input.connectionId,
          actor: { type: 'user', userId },
          context: { requestId },
        }),
      );
      if (!connection) throw new ORPCError('NOT_FOUND');
      if (connection.status === 'revoked') {
        try {
          await enqueuePurgeConnection({ tenantId, connectionId: connection.id });
        } catch (error) {
          // Revoked stands; the purge can be enqueued again by disconnecting again.
          log.error({ err: error, tenantId, connectionId: connection.id }, 'enqueue purge failed');
        }
      }
      // The mail of a disconnected connection is removed by the purge.
      return toSummary(session, connection, 0);
    },
  };
}
