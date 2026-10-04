import { type Database, getCardDetail, listCards, withTenant } from '@effectief/db';
import type { CardDetail, CardSummary } from '@effectief/shared';
import { ORPCError } from '@orpc/server';
import type { SessionContext } from '../auth/auth.ts';
import { toActionSummary } from './actions.ts';
import { toTimelineEvent } from './entities.ts';

interface CallContext {
  session: SessionContext;
}

type CardRow = NonNullable<Awaited<ReturnType<typeof getCardDetail>>>['card'];

const toCardSummary = (card: CardRow): CardSummary => ({
  id: card.id,
  kind: card.kind,
  status: card.status,
  title: card.title,
  summary: card.summary,
  priority: card.priority,
  snoozedUntil: card.snoozedUntil,
  createdAt: card.createdAt,
});

/** Cards of the session's tenant only; another tenant's card is NOT_FOUND (RLS). */
export function cardHandlers({ appDb }: { appDb: Database }) {
  return {
    async list(
      { session }: CallContext,
      input: { status: 'open' | 'snoozed'; limit: number },
    ): Promise<CardSummary[]> {
      const rows = await withTenant(appDb, session.tenantId, (tx) => listCards(tx, input));
      return rows.map(toCardSummary);
    },

    async get({ session }: CallContext, input: { id: string }): Promise<CardDetail> {
      const detail = await withTenant(appDb, session.tenantId, (tx) => getCardDetail(tx, input.id));
      if (!detail) throw new ORPCError('NOT_FOUND');
      const { card } = detail;
      return {
        ...toCardSummary(card),
        payload: card.payload,
        resolvedAt: card.resolvedAt,
        events: detail.events.map(toTimelineEvent),
        entities: detail.entities.map(({ id, type, name }) => ({ id, type, name })),
        actions: detail.actions.map((action) => ({
          ...toActionSummary(action),
          input: action.input,
        })),
      };
    },
  };
}
