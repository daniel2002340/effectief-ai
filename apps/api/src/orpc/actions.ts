import {
  type Action,
  approveAction,
  type Database,
  rejectAction,
  TransitionError,
  withTenant,
} from '@effectief/db';
import type { ActionSummary } from '@effectief/shared';
import { ValidationError } from '@orpc/contract';
import { ORPCError } from '@orpc/server';
import { ZodError } from 'zod';
import type { SessionContext } from '../auth/auth.ts';

/** Puts an approved action on the execute queue; the worker does the rest. */
export type EnqueueExecuteAction = (job: {
  tenantId: string;
  actionId: string;
  approvedAt: Date;
}) => Promise<void>;

interface ActionHandlerDependencies {
  appDb: Database;
  enqueueExecuteAction: EnqueueExecuteAction;
}

interface CallContext {
  session: SessionContext;
  requestId: string;
  log: { error: (object: object, message: string) => void };
}

const toSummary = (action: Action): ActionSummary => ({
  id: action.id,
  cardId: action.cardId,
  type: action.type,
  status: action.status,
  approvedAt: action.approvedAt,
  executedAt: action.executedAt,
  lastErrorCode: action.lastErrorCode,
});

/**
 * Refused transitions become CONFLICT or NOT_FOUND; an edited input that does
 * not fit the action's type becomes VALIDATION_FAILED. An action of another
 * tenant is invisible through RLS, so it is NOT_FOUND as well.
 */
function toApiError(error: unknown): unknown {
  if (error instanceof TransitionError) {
    return new ORPCError(error.code === 'not_found' ? 'NOT_FOUND' : 'CONFLICT');
  }
  if (error instanceof ZodError) {
    const issues = error.issues.map((issue) => ({ ...issue, path: ['input', ...issue.path] }));
    return new ORPCError('BAD_REQUEST', {
      cause: new ValidationError({ message: 'Invalid action input', issues }),
    });
  }
  return error;
}

export function actionHandlers({ appDb, enqueueExecuteAction }: ActionHandlerDependencies) {
  return {
    /**
     * The member from the session approves. Enqueueing happens after the
     * commit, so the worker never sees an approval that was rolled back.
     */
    async approve(
      { session, requestId, log }: CallContext,
      input: { actionId: string; input?: Record<string, unknown> | undefined },
    ): Promise<ActionSummary> {
      const { tenantId, userId } = session;
      const action = await withTenant(appDb, tenantId, (tx) =>
        approveAction(tx, {
          actionId: input.actionId,
          input: input.input,
          actor: { type: 'user', userId },
          context: { requestId },
        }),
      ).catch((error: unknown) => {
        throw toApiError(error);
      });
      if (!action.approvedAt) throw new Error(`Approved action ${action.id} has no approved_at`);
      try {
        await enqueueExecuteAction({
          tenantId,
          actionId: action.id,
          approvedAt: action.approvedAt,
        });
      } catch (error) {
        // The approval stands and stays visible as `approved`; see docs/todo.md.
        log.error({ err: error, tenantId, actionId: action.id }, 'enqueue execute-action failed');
      }
      return toSummary(action);
    },

    async reject(
      { session, requestId }: CallContext,
      input: { actionId: string },
    ): Promise<ActionSummary> {
      const { tenantId, userId } = session;
      const action = await withTenant(appDb, tenantId, (tx) =>
        rejectAction(tx, {
          actionId: input.actionId,
          actor: { type: 'user', userId },
          context: { requestId },
        }),
      ).catch((error: unknown) => {
        throw toApiError(error);
      });
      return toSummary(action);
    },
  };
}
