import {
  type CreateCardInput,
  cardAuditActions,
  cardTransitions,
  createCardInputSchema,
  type LinkCardInput,
  linkCardInputSchema,
  type TransitionCardInput,
  transitionCardInputSchema,
} from '@effectief/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { single } from '../memory/source.ts';
import { cardEntities, cardEvents, cards } from '../schema/index.ts';
import type { TenantTransaction } from '../with-tenant.ts';
import { writeAudit } from './audit.ts';
import { assertTransition, missedTransition } from './transition.ts';

export type Card = typeof cards.$inferSelect;

const idSchema = z.uuid();
const terminal = new Set(['done', 'dismissed', 'expired']);

/**
 * Creates a card with its links to events and entities. With a `dedupeKey`
 * that already has an open or snoozed card, that card gets the new links and
 * is returned with `created: false` (no second card per thread).
 */
export async function createCard(tx: TenantTransaction, input: CreateCardInput) {
  const { actor, context, eventIds, entityIds, ...values } = createCardInputSchema.parse(input);

  const [created] = await tx
    .insert(cards)
    .values(values)
    .onConflictDoNothing({
      target: [cards.tenantId, cards.dedupeKey],
      where: sql`${cards.status} in ('open', 'snoozed')`,
    })
    .returning();

  const card =
    created ??
    single(
      await tx
        .select()
        .from(cards)
        .where(
          and(
            eq(cards.dedupeKey, values.dedupeKey ?? ''),
            inArray(cards.status, ['open', 'snoozed']),
          ),
        ),
    );
  await linkCard(tx, { cardId: card.id, eventIds, entityIds });

  if (created) {
    await writeAudit(tx, {
      actor,
      context,
      action: 'card.created',
      objectType: 'cards',
      objectId: card.id,
      toStatus: card.status,
      metadata: { kind: card.kind },
    });
  }
  return { card, created: created !== undefined };
}

/** Adds links to events and entities; existing links are left as they are. */
export async function linkCard(tx: TenantTransaction, input: LinkCardInput) {
  const { cardId, eventIds, entityIds } = linkCardInputSchema.parse(input);
  const uniqueEvents = [...new Set(eventIds)];
  const uniqueEntities = [...new Set(entityIds)];
  if (uniqueEvents.length > 0) {
    await tx
      .insert(cardEvents)
      .values(uniqueEvents.map((eventId) => ({ cardId, eventId })))
      .onConflictDoNothing();
  }
  if (uniqueEntities.length > 0) {
    await tx
      .insert(cardEntities)
      .values(uniqueEntities.map((entityId) => ({ cardId, entityId })))
      .onConflictDoNothing();
  }
}

/**
 * The only way to change a card's status; same rules as transitionConnection().
 * Entering a final status sets resolved_at (and who, for a user); snoozing
 * sets snoozed_until, leaving it clears it.
 */
export async function transitionCard(tx: TenantTransaction, input: TransitionCardInput) {
  const parsed = transitionCardInputSchema.parse(input);
  const { cardId, from, to, actor, context } = parsed;
  assertTransition('cards', cardTransitions, from, to);

  const resolves = terminal.has(to);
  const [card] = await tx
    .update(cards)
    .set({
      status: to,
      snoozedUntil: parsed.to === 'snoozed' ? parsed.snoozedUntil : null,
      resolvedAt: resolves ? sql`now()` : null,
      resolvedByUserId: resolves && actor.type === 'user' ? actor.userId : null,
    })
    .where(and(eq(cards.id, cardId), eq(cards.status, from)))
    .returning();
  if (!card) {
    throw await missedTransition(
      tx,
      { name: 'cards', table: cards, id: cards.id, status: cards.status },
      cardId,
      from,
      to,
    );
  }

  await writeAudit(tx, {
    actor,
    context,
    action: cardAuditActions[to],
    objectType: 'cards',
    objectId: card.id,
    fromStatus: from,
    toStatus: to,
    metadata: { kind: card.kind },
  });
  return card;
}

export async function getCard(tx: TenantTransaction, cardId: string) {
  const [row] = await tx
    .select()
    .from(cards)
    .where(eq(cards.id, idSchema.parse(cardId)));
  return row;
}

/** The events and entities a card is linked to. */
export async function getCardLinks(tx: TenantTransaction, cardId: string) {
  const id = idSchema.parse(cardId);
  const eventRows = await tx
    .select({ id: cardEvents.eventId })
    .from(cardEvents)
    .where(eq(cardEvents.cardId, id));
  const entityRows = await tx
    .select({ id: cardEntities.entityId })
    .from(cardEntities)
    .where(eq(cardEntities.cardId, id));
  return {
    eventIds: eventRows.map((row) => row.id).sort(),
    entityIds: entityRows.map((row) => row.id).sort(),
  };
}

/** Open cards, most important and newest first. */
export function listFeed(tx: TenantTransaction, limit = 50) {
  return tx
    .select()
    .from(cards)
    .where(eq(cards.status, 'open'))
    .orderBy(desc(cards.priority), desc(cards.createdAt), desc(cards.id))
    .limit(z.int().min(1).max(200).parse(limit));
}
