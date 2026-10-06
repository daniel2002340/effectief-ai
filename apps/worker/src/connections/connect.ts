import {
  type ConnectAttempt,
  consumeConnectAttempt,
  createConnection,
  type Database,
  failConnectAttempt,
  findActiveAccountConnection,
  getConnectAttempt,
  getConnectionByNangoId,
  isOpenConnectAttempt,
  lockConnectAttempt,
  type TenantTransaction,
  withTenant,
} from '@effectief/db';
import {
  fetchMailboxAccount,
  type NangoClient,
  type NangoProvider,
  nangoProviders,
} from '@effectief/integrations/nango';
import type { Logger } from 'pino';

// Turning a connect attempt into a connection (docs/integrations.md §2.2,
// §2.4): the same work for the creation webhook, connections.complete and the
// sweep. Never a database transaction open during a Nango call: checks, then
// account-info at Nango, then one transaction that creates the connection and
// consumes the attempt.

export interface ConnectDependencies {
  db: Database;
  /** With the worker's key: account-info, deleting connections (§7.3). */
  nango: NangoClient;
  log: Logger;
  /** Tests move the clock; defaults to now. */
  now?: () => Date;
}

/** Runs the final transaction; the webhook job also marks its delivery processed there. */
export type Commit = <T>(fn: (tx: TenantTransaction) => Promise<T>) => Promise<T>;

export interface FinishAttemptInput {
  tenantId: string;
  attemptId: string;
  nangoConnectionId: string;
  integrationId: string;
  /** The webhook's tags; absent when the connection was found by the nonce tag itself. */
  tags?: { organization_id?: string | undefined; end_user_id?: string | undefined } | undefined;
  jobId: string;
  commit: Commit;
}

export type FinishAttemptResult =
  | 'connected'
  | 'already_connected'
  | 'duplicate_account'
  | 'rejected'
  | 'expired'
  | 'not_open';

const isNangoProvider = (provider: string): provider is NangoProvider =>
  (nangoProviders as string[]).includes(provider);

export async function finishConnectAttempt(
  { db, nango, log, now = () => new Date() }: ConnectDependencies,
  input: FinishAttemptInput,
): Promise<FinishAttemptResult> {
  const { tenantId, attemptId, nangoConnectionId, integrationId, commit } = input;
  const context = { jobId: input.jobId };
  const ids = { tenantId, attemptId, nangoConnectionId, integrationId, jobId: input.jobId };
  const ref = { integrationId, connectionId: nangoConnectionId };

  const { attempt, existing } = await withTenant(db, tenantId, async (tx) => ({
    attempt: await getConnectAttempt(tx, attemptId),
    existing: await getConnectionByNangoId(tx, nangoConnectionId),
  }));
  if (existing) {
    // A repeated webhook, or webhook and complete() both: done already.
    await commit(async () => {});
    return 'already_connected';
  }
  if (!attempt || attempt.consumedAt) {
    log.warn(
      { ...ids, consumed: Boolean(attempt?.consumedAt) },
      'connect attempt not open, ignored',
    );
    await commit(async () => {});
    return 'not_open';
  }
  if (!isOpenConnectAttempt(attempt, now())) {
    // Ours beyond doubt (the nonce matched) but too late: remove it at Nango (§2.3).
    await commit((tx) =>
      failConnectAttempt(tx, { attemptId, failureCode: 'expired', nangoConnectionId, context }),
    );
    await deleteAtNango(nango, log, ref, ids);
    return 'expired';
  }
  const refusal = refusalOf(attempt, input);
  if (refusal || !isNangoProvider(attempt.provider)) {
    // Logged with IDs only; the Nango connection is left alone (§2.2).
    log.warn({ ...ids, refusal: refusal ?? 'provider' }, 'connect attempt rejected');
    await commit((tx) =>
      failConnectAttempt(tx, { attemptId, failureCode: 'rejected', nangoConnectionId, context }),
    );
    return 'rejected';
  }

  const account = await fetchMailboxAccount(nango, attempt.provider, ref);

  const result = await commit(async (tx): Promise<FinishAttemptResult> => {
    const locked = await lockConnectAttempt(tx, attemptId);
    if (!locked || !isOpenConnectAttempt(locked, now())) return 'not_open';
    if (await getConnectionByNangoId(tx, nangoConnectionId)) return 'already_connected';
    const duplicate = await findActiveAccountConnection(
      tx,
      locked.provider,
      account.externalAccountId,
    );
    if (duplicate) {
      await failConnectAttempt(tx, {
        attemptId,
        failureCode: 'duplicate_account',
        nangoConnectionId,
        context,
      });
      return 'duplicate_account';
    }
    const createdBy = locked.createdByUserId;
    if (!createdBy) return 'not_open';
    const connection = await createConnection(tx, {
      provider: locked.provider,
      nangoIntegrationId: integrationId,
      nangoConnectionId,
      externalAccountId: account.externalAccountId,
      accountLabel: account.accountLabel,
      connectedByUserId: createdBy,
      actor: { type: 'user', userId: createdBy },
      context,
    });
    await consumeConnectAttempt(tx, { attemptId, connectionId: connection.id, nangoConnectionId });
    log.info({ ...ids, connectionId: connection.id }, 'connection created');
    return 'connected';
  });

  // The same mailbox is already connected here: this second Nango connection
  // is ours beyond doubt and must not keep syncing (§2.4).
  if (result === 'duplicate_account') await deleteAtNango(nango, log, ref, ids);
  return result;
}

/** Checks from §2.2 step 5; the membership is also enforced by the foreign key. */
function refusalOf(attempt: ConnectAttempt, input: FinishAttemptInput): string | undefined {
  if (attempt.nangoIntegrationId !== input.integrationId) return 'integration';
  if (!attempt.createdByUserId) return 'member';
  if (input.tags) {
    if (input.tags.organization_id !== input.tenantId) return 'tags';
    if (input.tags.end_user_id !== attempt.createdByUserId) return 'tags';
  }
  return undefined;
}

async function deleteAtNango(
  nango: NangoClient,
  log: Logger,
  ref: { integrationId: string; connectionId: string },
  ids: object,
) {
  try {
    await nango.deleteConnection(ref);
  } catch (error) {
    // The attempt is closed; an orphan at Nango is logged for a person to remove.
    log.error({ ...ids, err: error }, 'deleting nango connection failed');
  }
}
