import {
  type Connection,
  expireConnection,
  getConnection,
  reactivateConnection,
  type TenantTransaction,
  transitionConnection,
  withTenant,
} from '@effectief/db';
import {
  fetchMailboxAccount,
  NangoApiError,
  type NangoProvider,
  nangoProviders,
} from '@effectief/integrations/nango';
import type { PurgeConnectionJob, StoredNangoWebhook } from '@effectief/shared';
import type { Commit, ConnectDependencies } from './connect.ts';
import { finishConnectAttempt } from './connect.ts';

// A connection's life after connecting (docs/integrations.md §5, #077, #081):
// auth webhooks and the hourly health check lead to the same transitions.
// Whenever a grant works again, the account is checked first: a connection
// never reads another mailbox than the one connected (§2.4).

type EnqueuePurge = (job: PurgeConnectionJob) => Promise<void>;

export interface LifecycleDependencies extends ConnectDependencies {
  enqueuePurge: EnqueuePurge;
}

const system = { type: 'system' } as const;

const isNangoProvider = (provider: string): provider is NangoProvider =>
  (nangoProviders as string[]).includes(provider);

/** One stored auth webhook (§4.1). `commit` also marks the delivery processed. */
export async function handleAuthWebhook(
  deps: LifecycleDependencies,
  input: {
    tenantId: string;
    connectionId: string | null;
    connectAttemptId: string | null;
    payload: Extract<StoredNangoWebhook, { type: 'auth' }>;
    jobId: string;
    commit: Commit;
  },
): Promise<void> {
  const { tenantId, payload, jobId, commit } = input;
  if (payload.operation === 'creation') {
    if (!input.connectAttemptId || !payload.success) {
      await commit(async () => {});
      return;
    }
    await finishConnectAttempt(deps, {
      tenantId,
      attemptId: input.connectAttemptId,
      nangoConnectionId: payload.connectionId,
      integrationId: payload.providerConfigKey,
      tags: payload.tags ?? {},
      jobId,
      commit,
    });
    return;
  }

  const connection = input.connectionId
    ? await withTenant(deps.db, tenantId, (tx) => getConnection(tx, input.connectionId ?? ''))
    : undefined;
  if (!connection || connection.status === 'revoked' || connection.status === 'purged') {
    // A tombstone: late webhooks change nothing (§5.3).
    await commit(async () => {});
    return;
  }
  const context = { jobId };

  if (payload.operation === 'deletion') {
    await commit((tx) => revoke(deps, tx, connection, context));
    return;
  }
  if (payload.operation === 'refresh' && !payload.success) {
    deps.log.info(
      { tenantId, connectionId: connection.id, errorType: payload.error?.type },
      'nango refresh failed',
    );
    await commit((tx) =>
      expireConnection(tx, { connectionId: connection.id, reason: 'invalid_grant', context }),
    );
    return;
  }
  // `override` (re-authorized) or `refresh` recovered.
  if (payload.operation === 'refresh' && connection.status === 'active') {
    await commit(async () => {});
    return;
  }
  await applyAccountCheck(deps, {
    tenantId,
    connection,
    reason: payload.operation === 'override' ? 'reauthorized' : 'auth_recovered',
    jobId,
    commit,
  });
}

/**
 * The grant works: compare the account with the one connected. Same → active
 * (or an audit entry if it was active); another → expired with
 * `account_mismatch` and a card, so ingest stops reading it.
 */
async function applyAccountCheck(
  { nango }: LifecycleDependencies,
  input: {
    tenantId: string;
    connection: Connection;
    reason: 'reauthorized' | 'auth_recovered';
    jobId: string;
    commit: Commit;
  },
) {
  const { connection, commit } = input;
  const context = { jobId: input.jobId };
  if (!isNangoProvider(connection.provider)) {
    await commit(async () => {});
    return;
  }
  const account = await fetchMailboxAccount(nango, connection.provider, {
    integrationId: connection.nangoIntegrationId,
    connectionId: connection.nangoConnectionId,
  });
  await commit(async (tx) => {
    if (account.externalAccountId !== connection.externalAccountId) {
      await expireConnection(tx, {
        connectionId: connection.id,
        reason: 'account_mismatch',
        context,
      });
      return;
    }
    await reactivateConnection(tx, { connectionId: connection.id, reason: input.reason, context });
  });
}

/** Gone at Nango: revoked, and its data purged by the purge job (§5.2). */
async function revoke(
  { enqueuePurge }: LifecycleDependencies,
  tx: TenantTransaction,
  connection: Connection,
  context: { jobId: string },
) {
  const current = await getConnection(tx, connection.id);
  if (current?.status !== 'active' && current?.status !== 'expired') return;
  await transitionConnection(tx, {
    connectionId: connection.id,
    from: current.status,
    to: 'revoked',
    reason: 'provider_revoked',
    actor: system,
    context,
  });
  // Inside the transaction: if it rolls back, the purge job finds the
  // connection not revoked and refuses, visibly.
  await enqueuePurge({ tenantId: connection.tenantId, connectionId: connection.id });
}

export type HealthResult =
  | 'healthy'
  | 'expired'
  | 'revoked'
  | 'reactivated'
  | 'mismatch'
  | 'skipped';

/**
 * The hourly safety net for missed auth webhooks (§4.6): asks Nango how the
 * connection is doing and applies the same transitions as the webhooks.
 */
export async function checkConnectionHealth(
  deps: LifecycleDependencies,
  input: { tenantId: string; connection: Connection; jobId: string },
): Promise<HealthResult> {
  const { connection, tenantId, jobId } = input;
  const context = { jobId };
  if (connection.status !== 'active' && connection.status !== 'expired') return 'skipped';
  const commit: Commit = (fn) => withTenant(deps.db, tenantId, fn);
  let health: Awaited<ReturnType<typeof deps.nango.getConnection>>;
  try {
    health = await deps.nango.getConnection({
      integrationId: connection.nangoIntegrationId,
      connectionId: connection.nangoConnectionId,
    });
  } catch (error) {
    if (error instanceof NangoApiError && error.kind === 'not_found') {
      await commit((tx) => revoke(deps, tx, connection, context));
      return 'revoked';
    }
    throw error;
  }
  if (health.authError) {
    if (connection.status === 'expired') return 'expired';
    await commit((tx) =>
      expireConnection(tx, { connectionId: connection.id, reason: 'invalid_grant', context }),
    );
    return 'expired';
  }
  if (connection.status === 'active') return 'healthy';
  // Expired, but Nango says the grant works: a recovery or re-authorization we missed.
  const before = connection.statusReason;
  await applyAccountCheck(deps, {
    tenantId,
    connection,
    reason: before === 'account_mismatch' ? 'reauthorized' : 'auth_recovered',
    jobId,
    commit,
  });
  const after = await withTenant(deps.db, tenantId, (tx) => getConnection(tx, connection.id));
  return after?.status === 'active' ? 'reactivated' : 'mismatch';
}
