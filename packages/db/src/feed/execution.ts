import type { ActionErrorCode, ActionType, AuditContext } from '@effectief/shared';
import { z } from 'zod';
import { recordEvent } from '../memory/events.ts';
import type { TenantTransaction } from '../with-tenant.ts';
import { type Action, getAction, transitionAction } from './actions.ts';
import { createCard, getCard, getCardLinks, linkCard, transitionCard } from './cards.ts';
import { expireConnection } from './connection-status.ts';
import { type Connection, getConnection } from './connections.ts';
import { TransitionError } from './transition.ts';

// Executing an approved action, in three steps around the provider call
// (#004, decision #050). Each step is its own transaction; no transaction is
// open while the adapter talks to the provider.
//   1. claimExecution: approved → executing, owned by one job.
//   2. the adapter call, with the idempotency key (in the worker).
//   3. completeExecution or failExecution.

const system = { type: 'system' } as const;
const jobIdSchema = z.string().regex(/^[\w.:/#-]{1,128}$/);

export type Claim =
  /** This job owns the action; `resumed` when a retry of the same job finds it executing. */
  | { kind: 'claimed' | 'resumed'; action: Action; connection: Connection }
  /** Not executable by this job: not approved, or claimed by another job. */
  | { kind: 'skipped'; status: Action['status'] | 'not_found' };

/**
 * Claims an approved action for one job. Only `approved` can be claimed, so a
 * job started without approval (or for a rejected, executed or failed action)
 * does nothing. Of two jobs racing for the same action, the guarded update
 * lets exactly one win. A retry of the job that owns an `executing` action
 * resumes it.
 */
export async function claimExecution(
  tx: TenantTransaction,
  input: { actionId: string; jobId: string; context?: AuditContext },
): Promise<Claim> {
  const jobId = jobIdSchema.parse(input.jobId);
  const current = await getAction(tx, input.actionId);
  if (!current) return { kind: 'skipped', status: 'not_found' };

  let action = current;
  let kind: 'claimed' | 'resumed';
  if (current.status === 'executing' && current.executionJobId === jobId) {
    kind = 'resumed';
  } else if (current.status === 'approved') {
    try {
      action = await transitionAction(tx, {
        actionId: current.id,
        from: 'approved',
        to: 'executing',
        jobId,
        actor: system,
        context: input.context,
      });
    } catch (error) {
      if (error instanceof TransitionError && error.code === 'status_changed') {
        return { kind: 'skipped', status: (error.current ?? 'not_found') as Action['status'] };
      }
      throw error;
    }
    kind = 'claimed';
  } else {
    return { kind: 'skipped', status: current.status };
  }

  const connection = await getConnection(tx, action.connectionId);
  if (!connection) throw new Error(`Connection of action ${action.id} not found`);
  return { kind, action, connection };
}

/** The action must still be executing and owned by this job. */
async function ownedExecution(tx: TenantTransaction, actionId: string, jobId: string) {
  const action = await getAction(tx, actionId);
  if (action?.status !== 'executing' || action.executionJobId !== jobId) {
    throw new TransitionError(
      action ? 'status_changed' : 'not_found',
      'actions',
      'executing',
      'executed',
      action?.status,
    );
  }
  return action;
}

/**
 * After the provider answered: executed with the provider object, an event
 * `action.executed` on the card's timeline, and the card done. One
 * transaction, so either all of it is recorded or none (and the job retries).
 */
export async function completeExecution(
  tx: TenantTransaction,
  input: {
    actionId: string;
    jobId: string;
    providerObjectId: string;
    result: Record<string, unknown>;
    context?: AuditContext;
  },
) {
  const { actionId, jobId, providerObjectId, result, context } = input;
  await ownedExecution(tx, actionId, jobId);
  const action = await transitionAction(tx, {
    actionId,
    from: 'executing',
    to: 'executed',
    providerObjectId,
    result,
    actor: system,
    context,
  });

  const { event } = await recordEvent(tx, {
    event: {
      source: 'app',
      // One event per execution: an update after an edit is a new event.
      externalId: `action:${action.id}:${action.attempts}`,
      type: 'action.executed',
      occurredAt: new Date(),
      connectionId: action.connectionId,
      causedByActionId: action.id,
      payload: { providerObjectId },
    },
  });
  await linkCard(tx, { cardId: action.cardId, eventIds: [event.id] });

  const card = await getCard(tx, action.cardId);
  if (card && (card.status === 'open' || card.status === 'snoozed')) {
    await transitionCard(tx, {
      cardId: card.id,
      from: card.status,
      to: 'done',
      actor: system,
      context,
    });
  }
  return action;
}

const failureTitles: Record<ActionType, string> = {
  'email.reply': 'Antwoordmail niet verstuurd',
  'moneybird.quote': 'Offerte niet klaargezet in Moneybird',
  'moneybird.invoice_reminder': 'Betaalherinnering niet verstuurd',
  'mollie.payment_link': 'Betaallink niet aangemaakt',
};

/**
 * Executing failed for good: failed with the error code, and a card so the
 * user sees it and can retry or edit. `auth_expired` also expires the
 * connection with its own card, so nothing keeps retrying on a dead grant.
 */
export async function failExecution(
  tx: TenantTransaction,
  input: { actionId: string; jobId: string; errorCode: ActionErrorCode; context?: AuditContext },
) {
  const { actionId, jobId, errorCode, context } = input;
  await ownedExecution(tx, actionId, jobId);
  const action = await transitionAction(tx, {
    actionId,
    from: 'executing',
    to: 'failed',
    errorCode,
    actor: system,
    context,
  });

  if (errorCode === 'auth_expired') {
    await expireConnection(tx, {
      connectionId: action.connectionId,
      reason: 'invalid_grant',
      context,
    });
  }

  // The failure card points at the same entities as the card of the action.
  const { entityIds } = await getCardLinks(tx, action.cardId);
  const { card } = await createCard(tx, {
    kind: 'action_failed',
    actionId,
    title: failureTitles[action.type],
    payload: { errorCode },
    priority: 3,
    dedupeKey: `action_failed:${actionId}`,
    entityIds,
    actor: system,
    context,
  });
  return { action, card };
}
