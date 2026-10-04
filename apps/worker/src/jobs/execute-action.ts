import {
  claimExecution,
  completeExecution,
  type Database,
  failExecution,
  withTenant,
} from '@effectief/db';
import { AdapterError, type AdapterRegistry, adapterFor } from '@effectief/integrations';
import {
  type ActionErrorCode,
  type ActionStatus,
  actionRegistry,
  executeActionJobSchema,
} from '@effectief/shared';
import type { Logger } from 'pino';

export interface ExecuteActionDependencies {
  db: Database;
  adapters: AdapterRegistry;
  log: Logger;
}

export interface ExecuteJobInfo {
  jobId: string;
  /** Attempts BullMQ made before this one. */
  attemptsMade: number;
  maxAttempts: number;
}

export type ExecuteActionOutcome =
  | { outcome: 'skipped'; status: ActionStatus | 'not_found' }
  | { outcome: 'executed'; providerObjectId: string }
  | { outcome: 'failed'; errorCode: ActionErrorCode };

/**
 * Executes one approved action (#004, decision #050):
 * 1. claim it (approved → executing) for this job; anything else is skipped,
 *    so starting the job never bypasses approval and a second job does nothing;
 * 2. call the adapter with the idempotency key, outside any transaction;
 *    with a provider object from an earlier execution, the adapter updates it;
 * 3. record executed, or failed with a card for the user.
 * A retryable error is thrown so BullMQ retries; the action stays executing
 * and owned by this job, and the retry resumes it. On the last attempt, or
 * for an error that will not get better, the action fails.
 */
export async function processExecuteActionJob(
  data: unknown,
  job: ExecuteJobInfo,
  { db, adapters, log }: ExecuteActionDependencies,
): Promise<ExecuteActionOutcome> {
  const { tenantId, actionId } = executeActionJobSchema.parse(data);
  const { jobId } = job;
  const context = { jobId };
  const ids = { jobId, tenantId, actionId };

  const claim = await withTenant(db, tenantId, (tx) =>
    claimExecution(tx, { actionId, jobId, context }),
  );
  if (claim.kind === 'skipped') {
    log.info({ ...ids, status: claim.status }, 'action not executable, skipped');
    return { outcome: 'skipped', status: claim.status };
  }
  const { action, connection } = claim;

  const fail = async (errorCode: ActionErrorCode): Promise<ExecuteActionOutcome> => {
    await withTenant(db, tenantId, (tx) =>
      failExecution(tx, { actionId, jobId, errorCode, context }),
    );
    log.warn({ ...ids, type: action.type, errorCode }, 'action failed');
    return { outcome: 'failed', errorCode };
  };

  if (connection.status !== 'active') return fail('connection_inactive');
  const input = actionRegistry[action.type].input.safeParse(action.input);
  if (!input.success) return fail('invalid_input');
  const adapter = adapterFor(adapters, connection.provider, action.type);
  if (!adapter) return fail('unsupported');

  let response: Awaited<ReturnType<typeof adapter.execute>>;
  try {
    response = await adapter.execute({
      type: action.type,
      input: input.data,
      connection: {
        tenantId,
        connectionId: connection.id,
        provider: connection.provider,
        nangoIntegrationId: connection.nangoIntegrationId,
        nangoConnectionId: connection.nangoConnectionId,
      },
      idempotencyKey: action.idempotencyKey,
      providerObjectId: action.providerObjectId,
    } as Parameters<typeof adapter.execute>[0]);
  } catch (error) {
    // Unknown errors (a bug, a network hiccup) are retried like provider outages.
    const code = error instanceof AdapterError ? error.code : 'unknown';
    const retryable = error instanceof AdapterError ? error.retryable : true;
    const lastAttempt = job.attemptsMade + 1 >= job.maxAttempts;
    // The error name only: provider messages can hold personal data.
    log.warn(
      { ...ids, errorCode: code, retryable, lastAttempt, errorName: (error as Error).name },
      'adapter call failed',
    );
    if (retryable && !lastAttempt) throw error;
    return fail(code);
  }

  // If this fails, the job is retried and resumes; the adapter returns the
  // object it already made for this idempotency key.
  await withTenant(db, tenantId, (tx) =>
    completeExecution(tx, {
      actionId,
      jobId,
      providerObjectId: response.providerObjectId,
      result: response.result,
      context,
    }),
  );
  log.info({ ...ids, type: action.type }, 'action executed');
  return { outcome: 'executed', providerObjectId: response.providerObjectId };
}
