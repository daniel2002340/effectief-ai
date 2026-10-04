import type { ActionStatus, CardStatus, ConnectionStatus } from '@effectief/shared';
import type { TestTenant } from '../test-support.ts';
import type { TenantTransaction } from '../with-tenant.ts';
import { type Action, proposeAction, transitionAction } from './actions.ts';
import { type Card, transitionCard } from './cards.ts';
import { type Connection, transitionConnection } from './connections.ts';
import {
  agent,
  asUser,
  createTestCard,
  createTestConnection,
  quoteInput,
  replyInput,
  system,
} from './test-fixtures.ts';

type TestActionType = 'email.reply' | 'moneybird.quote';
type InTenant = <T>(fn: (tx: TenantTransaction) => Promise<T>) => Promise<T>;

/** Rows in a given status, reached through allowed transitions only. */
export function rowsInStatus(inTenant: InTenant, tenant: TestTenant) {
  const user = asUser(tenant.userId);

  async function connectionIn(status: ConnectionStatus): Promise<Connection> {
    return inTenant(async (tx) => {
      const created = await createTestConnection(tx, tenant);
      const path: Record<ConnectionStatus, ConnectionStatus[]> = {
        active: [],
        expired: ['expired'],
        revoked: ['revoked'],
        purged: ['revoked', 'purged'],
      };
      let row = created;
      for (const to of path[status]) {
        row = await transitionConnection(tx, {
          connectionId: row.id,
          from: row.status,
          to,
          reason: 'user_disconnected',
          actor: user,
        });
      }
      return row;
    });
  }

  async function cardIn(status: CardStatus): Promise<Card> {
    return inTenant(async (tx) => {
      const card = await createTestCard(tx);
      if (status === 'open') return card;
      if (status === 'snoozed') {
        return transitionCard(tx, {
          cardId: card.id,
          from: 'open',
          to: 'snoozed',
          snoozedUntil: new Date(Date.now() + 86_400_000),
          actor: user,
        });
      }
      return transitionCard(tx, { cardId: card.id, from: 'open', to: status, actor: user });
    });
  }

  async function proposed(tx: TenantTransaction, type: TestActionType) {
    const card = await createTestCard(tx);
    if (type === 'moneybird.quote') {
      const connection = await createTestConnection(tx, tenant, 'moneybird');
      const { action } = await proposeAction(tx, {
        cardId: card.id,
        connectionId: connection.id,
        type,
        input: quoteInput,
        actor: agent,
      });
      return action;
    }
    const connection = await createTestConnection(tx, tenant);
    const { action } = await proposeAction(tx, {
      cardId: card.id,
      connectionId: connection.id,
      type,
      input: replyInput,
      actor: agent,
    });
    return action;
  }

  /** `email.reply` is final after executing, `moneybird.quote` can be updated. */
  async function actionIn(
    status: ActionStatus,
    type: TestActionType = 'email.reply',
  ): Promise<Action> {
    return inTenant(async (tx) => {
      const action = await proposed(tx, type);
      if (status === 'concept') return action;
      if (status === 'rejected') {
        return transitionAction(tx, {
          actionId: action.id,
          from: 'concept',
          to: 'rejected',
          actor: user,
        });
      }
      const approved = await transitionAction(tx, {
        actionId: action.id,
        from: 'concept',
        to: 'approved',
        actor: user,
      });
      if (status === 'approved') return approved;
      const executing = await transitionAction(tx, {
        actionId: action.id,
        from: 'approved',
        to: 'executing',
        jobId: `job-${action.id}`,
        actor: system,
      });
      if (status === 'executing') return executing;
      if (status === 'executed') {
        return transitionAction(tx, {
          actionId: action.id,
          from: 'executing',
          to: 'executed',
          providerObjectId: `draft-${action.id}`,
          result: { providerThreadId: 'thread-1' },
          actor: system,
        });
      }
      return transitionAction(tx, {
        actionId: action.id,
        from: 'executing',
        to: 'failed',
        errorCode: 'provider_unavailable',
        actor: system,
      });
    });
  }

  return { connectionIn, cardIn, actionIn };
}
