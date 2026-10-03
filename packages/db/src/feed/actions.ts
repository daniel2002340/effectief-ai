import {
  type ActionType,
  actionAuditActions,
  actionInputSchemas,
  actionProviders,
  actionResultSchemas,
  actionTransitions,
  type ProposeActionInput,
  proposeActionInputSchema,
  type TransitionActionInput,
  transitionActionInputSchema,
} from '@effectief/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { single } from '../memory/source.ts';
import { actions } from '../schema/index.ts';
import type { TenantTransaction } from '../with-tenant.ts';
import { writeAudit } from './audit.ts';
import { getConnection } from './connections.ts';
import { assertTransition, missedTransition, TransitionError } from './transition.ts';

// The action pipeline: proposeAction → approve → execute (#004). These
// functions only record state; calling the provider happens in the execute
// job through the integration adapter, with the idempotency key.

export type Action = typeof actions.$inferSelect;

const idSchema = z.uuid();
const target = { name: 'actions', table: actions, id: actions.id, status: actions.status };

/** Deterministic, so a retried proposal finds the action it already made. */
export const idempotencyKeyOf = (cardId: string, type: ActionType, ordinal: number) =>
  `${cardId}:${type}:${ordinal}`;

/**
 * Records a proposed action as `concept`; the AI or the system may propose,
 * nothing is executed here. Input is parsed with the schema of the type and
 * stored twice: `proposed_input` stays as proposed, `input` is what the user
 * may edit. A repeat with the same card, type and ordinal returns the existing
 * action with `created: false`.
 */
export async function proposeAction(tx: TenantTransaction, input: ProposeActionInput) {
  const proposal = proposeActionInputSchema.parse(input);
  const { actor, context, cardId, connectionId, type, ordinal } = proposal;

  const connection = await getConnection(tx, connectionId);
  const providers: readonly string[] = actionProviders[type];
  if (connection?.status !== 'active' || !providers.includes(connection.provider)) {
    throw new Error(`Connection ${connectionId} cannot execute ${type}`);
  }

  const idempotencyKey = idempotencyKeyOf(cardId, type, ordinal);
  const [created] = await tx
    .insert(actions)
    .values({
      cardId,
      connectionId,
      type,
      proposedInput: proposal.input,
      input: proposal.input,
      idempotencyKey,
      playbookId: proposal.playbookId,
      aiModel: proposal.aiModel,
      aiTraceId: proposal.aiTraceId,
    })
    .onConflictDoNothing({ target: [actions.tenantId, actions.idempotencyKey] })
    .returning();
  if (!created) {
    const existing = single(
      await tx.select().from(actions).where(eq(actions.idempotencyKey, idempotencyKey)),
    );
    return { action: existing, created: false };
  }

  await writeAudit(tx, {
    actor,
    context,
    action: 'action.proposed',
    objectType: 'actions',
    objectId: created.id,
    toStatus: created.status,
    metadata: { type, cardId },
  });
  return { action: created, created: true };
}

/**
 * The only way to change an action's status. Refuses transitions outside
 * actionTransitions; approving and rejecting need a user. The update applies
 * only if the status is still `from`, so of two concurrent transitions one
 * wins and the other throws `status_changed`. The trigger actions_guard
 * enforces the same transitions in the database. Writes one audit entry in
 * the same transaction.
 */
export async function transitionAction(tx: TenantTransaction, input: TransitionActionInput) {
  const parsed = transitionActionInputSchema.parse(input);
  const { actionId, from, to, actor, context } = parsed;
  assertTransition('actions', actionTransitions, from, to);

  const [current] = await tx
    .select({ type: actions.type })
    .from(actions)
    .where(eq(actions.id, actionId));
  if (!current) throw new TransitionError('not_found', 'actions', from, to);
  const { type } = current;

  const changes = (() => {
    switch (parsed.to) {
      case 'approved': {
        if (parsed.input !== undefined && from !== 'concept') {
          throw new Error('The input of an action can only change while it is a concept');
        }
        return {
          approvedByUserId: parsed.actor.userId,
          approvedAt: sql`now()`,
          ...(parsed.input === undefined
            ? {}
            : { input: actionInputSchemas[type].parse(parsed.input) }),
        };
      }
      case 'rejected':
        return {};
      case 'executed':
        return {
          providerObjectId: parsed.providerObjectId,
          result: actionResultSchemas[type].parse(parsed.result),
          executedAt: sql`now()`,
          attempts: sql`${actions.attempts} + 1`,
          lastErrorCode: null,
        };
      case 'failed':
        return { lastErrorCode: parsed.errorCode, attempts: sql`${actions.attempts} + 1` };
      case 'concept':
        // Editing after execution needs a new approval.
        return { approvedByUserId: null, approvedAt: null };
    }
  })();

  const [action] = await tx
    .update(actions)
    .set({ status: to, ...changes })
    .where(and(eq(actions.id, actionId), eq(actions.status, from)))
    .returning();
  if (!action) throw await missedTransition(tx, target, actionId, from, to);

  await writeAudit(tx, {
    actor,
    context,
    action: actionAuditActions[to],
    objectType: 'actions',
    objectId: action.id,
    fromStatus: from,
    toStatus: to,
    metadata: {
      type,
      cardId: action.cardId,
      ...(to === 'executed' && action.providerObjectId
        ? { providerObjectId: action.providerObjectId, attempts: action.attempts }
        : {}),
      ...(to === 'failed' && action.lastErrorCode
        ? { errorCode: action.lastErrorCode, attempts: action.attempts }
        : {}),
    },
  });
  return action;
}

export async function getAction(tx: TenantTransaction, actionId: string) {
  const [row] = await tx
    .select()
    .from(actions)
    .where(eq(actions.id, idSchema.parse(actionId)));
  return row;
}

export function listCardActions(tx: TenantTransaction, cardId: string) {
  return tx
    .select()
    .from(actions)
    .where(eq(actions.cardId, idSchema.parse(cardId)))
    .orderBy(asc(actions.createdAt), asc(actions.id));
}
