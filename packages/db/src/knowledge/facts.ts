import {
  type CreateFactInput,
  createFactInputSchema,
  factTransitions,
  type ReplaceFactInput,
  type ReviewFactInput,
  replaceFactInputSchema,
  reviewFactInputSchema,
} from '@effectief/shared';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { writeAudit } from '../feed/audit.ts';
import { assertTransition, missedTransition } from '../feed/transition.ts';
import { single, sourceColumnsOf } from '../memory/source.ts';
import { facts } from '../schema/index.ts';
import type { TenantTransaction } from '../with-tenant.ts';
import { KnowledgeError } from './errors.ts';

// Facts are never overwritten (docs/data-model.md, facts): the content has no
// UPDATE privilege, and a fact that ended (valid_to) stays ended (trigger
// facts_end_once). A newer truth is a new row that supersedes the old one.

export type Fact = typeof facts.$inferSelect;

const idSchema = z.uuid();
const factTarget = { name: 'facts', table: facts, id: facts.id, status: facts.status };

/** Always `proposed`: confirming is a separate user step (docs/data-model.md §2). */
export async function createFact(tx: TenantTransaction, input: CreateFactInput) {
  const { source, attribute, structured, ...fact } = createFactInputSchema.parse(input);
  return single(
    await tx
      .insert(facts)
      .values({
        ...fact,
        attribute: attribute ?? structured?.attribute ?? null,
        structured: structured ?? null,
        ...sourceColumnsOf(source),
      })
      .returning(),
  );
}

export async function getFact(tx: TenantTransaction, factId: string) {
  const [row] = await tx
    .select()
    .from(facts)
    .where(eq(facts.id, idSchema.parse(factId)));
  return row;
}

/** What is currently known about an entity: not ended, not rejected. */
export function listCurrentFacts(tx: TenantTransaction, entityId: string) {
  return tx
    .select()
    .from(facts)
    .where(
      and(
        eq(facts.entityId, idSchema.parse(entityId)),
        isNull(facts.validTo),
        ne(facts.status, 'rejected'),
      ),
    )
    .orderBy(asc(facts.createdAt), asc(facts.id));
}

/**
 * Ends a current, confirmed fact: valid_to now, superseded_by_id the new fact.
 * Returns undefined when the fact was not current (already ended, or never
 * confirmed), so the caller decides whether that is an error.
 */
async function endFact(tx: TenantTransaction, factId: string) {
  const [ended] = await tx
    .update(facts)
    .set({ validTo: sql`now()` })
    .where(and(eq(facts.id, factId), eq(facts.status, 'confirmed'), isNull(facts.validTo)))
    .returning();
  return ended;
}

async function linkSuperseded(
  tx: TenantTransaction,
  old: Fact,
  newFactId: string,
  audit: Pick<ReviewFactInput, 'actor' | 'context'>,
) {
  await tx.update(facts).set({ supersededById: newFactId }).where(eq(facts.id, old.id));
  await writeAudit(tx, {
    actor: audit.actor,
    context: audit.context,
    action: 'fact.superseded',
    objectType: 'facts',
    objectId: old.id,
    metadata: { entityId: old.entityId, supersededById: newFactId },
  });
}

/** proposed → confirmed by a user; the guarded UPDATE refuses a stale status. */
async function markConfirmed(
  tx: TenantTransaction,
  factId: string,
  { actor, context }: z.output<typeof reviewFactInputSchema>,
) {
  assertTransition('facts', factTransitions, 'proposed', 'confirmed');
  const [fact] = await tx
    .update(facts)
    .set({
      status: 'confirmed',
      confirmedAt: sql`now()`,
      confirmedByUserId: actor.userId,
      lastConfirmedAt: sql`now()`,
    })
    .where(and(eq(facts.id, factId), eq(facts.status, 'proposed'), isNull(facts.validTo)))
    .returning();
  if (!fact) throw await missedTransition(tx, factTarget, factId, 'proposed', 'confirmed');
  await writeAudit(tx, {
    actor,
    context,
    action: 'fact.confirmed',
    objectType: 'facts',
    objectId: fact.id,
    fromStatus: 'proposed',
    toStatus: 'confirmed',
    metadata: { entityId: fact.entityId },
  });
  return fact;
}

/**
 * A user confirms a proposed fact. When the entity already has a current,
 * confirmed fact with the same attribute, that one ends and points to this
 * one, in the same transaction (docs/data-model.md, facts: contradiction).
 */
export async function confirmFact(tx: TenantTransaction, input: ReviewFactInput) {
  const review = reviewFactInputSchema.parse(input);
  const proposed = await getFact(tx, review.factId);
  if (!proposed)
    throw await missedTransition(tx, factTarget, review.factId, 'proposed', 'confirmed');

  let replaced: Fact | undefined;
  if (proposed.attribute !== null && proposed.status === 'proposed') {
    const [current] = await tx
      .select({ id: facts.id })
      .from(facts)
      .where(
        and(
          eq(facts.entityId, proposed.entityId),
          eq(facts.attribute, proposed.attribute),
          eq(facts.status, 'confirmed'),
          isNull(facts.validTo),
        ),
      );
    if (current) replaced = await endFact(tx, current.id);
  }

  const fact = await markConfirmed(tx, proposed.id, review);
  if (replaced) await linkSuperseded(tx, replaced, fact.id, review);
  return { fact, replaced };
}

export async function rejectFact(tx: TenantTransaction, input: ReviewFactInput) {
  const { factId, actor, context } = reviewFactInputSchema.parse(input);
  assertTransition('facts', factTransitions, 'proposed', 'rejected');
  const [fact] = await tx
    .update(facts)
    .set({ status: 'rejected' })
    .where(and(eq(facts.id, factId), eq(facts.status, 'proposed')))
    .returning();
  if (!fact) throw await missedTransition(tx, factTarget, factId, 'proposed', 'rejected');
  await writeAudit(tx, {
    actor,
    context,
    action: 'fact.rejected',
    objectType: 'facts',
    objectId: fact.id,
    fromStatus: 'proposed',
    toStatus: 'rejected',
    metadata: { entityId: fact.entityId },
  });
  return fact;
}

/**
 * A correction by the user (docs/data-model.md §6.2, step 5): the current
 * fact ends (valid_to, superseded_by_id) and a new, confirmed fact about the
 * same entity takes its place, in one transaction. The old text is never
 * changed. Only a current, confirmed fact can be replaced; replacing it twice
 * fails with `not_current`.
 */
export async function replaceFact(tx: TenantTransaction, input: ReplaceFactInput) {
  const { factId, statement, attribute, structured, actor, context } =
    replaceFactInputSchema.parse(input);

  const old = await endFact(tx, factId);
  if (!old) {
    const exists = await getFact(tx, factId);
    throw new KnowledgeError(exists ? 'not_current' : 'not_found', 'facts', factId);
  }

  const resolvedAttribute = attribute ?? structured?.attribute ?? old.attribute;
  const proposed = await createFact(tx, {
    entityId: old.entityId,
    statement,
    attribute: resolvedAttribute,
    structured,
    source: { sourceType: 'user', sourceUserId: actor.userId },
  });
  const fact = await markConfirmed(tx, proposed.id, { factId: proposed.id, actor, context });
  await linkSuperseded(tx, old, fact.id, { actor, context });
  return { fact, replaced: { ...old, supersededById: fact.id } };
}
