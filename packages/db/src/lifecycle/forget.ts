import { type ForgetEntityInput, forgetEntityInputSchema } from '@effectief/shared';
import { inArray, sql } from 'drizzle-orm';
import { writeAudit } from '../feed/audit.ts';
import {
  cardEntities,
  cardEvents,
  cards,
  entities,
  eventEntities,
  events,
  taskEntities,
  tasks,
} from '../schema/index.ts';
import type { TenantTransaction } from '../with-tenant.ts';

// Right to be forgotten (docs/data-model.md §6.3, decision #040). Personal
// data is deleted, never soft-deleted; what is not deleted here goes through
// ON DELETE CASCADE from entities and events, including facts, playbooks of
// the customer, embeddings and insights. audit_log keeps one entry with ids
// and counts, without the name or identifiers.

export interface ForgetResult {
  entities: number;
  events: number;
  cards: number;
  tasks: number;
}

const unique = (rows: { id: string }[]) => [...new Set(rows.map((row) => row.id))];

/**
 * Forgets a person (or company) and everything about them, in the caller's
 * transaction so it is all or nothing. Duplicates merged into the entity are
 * the same person and are forgotten too. Returns null when the entity does
 * not exist (anymore), so a repeated job is harmless.
 *
 * Deleted directly: the entities, the events linked to them in any role, the
 * cards linked to them or to those events (with their actions), and their
 * tasks. Free text elsewhere that mentions them (another customer's fact, a
 * document) is not searched yet: open question 5, docs/todo.md.
 */
export async function forgetEntity(
  tx: TenantTransaction,
  input: ForgetEntityInput,
): Promise<ForgetResult | null> {
  const { entityId, actor, context } = forgetEntityInputSchema.parse(input);

  const { rows: entityRows } = await tx.execute<{ id: string }>(sql`
    with recursive forgotten (id) as (
      select id from entities where id = ${entityId}
      union
      select e.id from entities e join forgotten f on e.merged_into_id = f.id
    )
    select id from forgotten
  `);
  if (entityRows.length === 0) return null;
  const entityIds = unique(entityRows);

  const eventIds = unique(
    await tx
      .select({ id: eventEntities.eventId })
      .from(eventEntities)
      .where(inArray(eventEntities.entityId, entityIds)),
  );
  const cardIds = unique([
    ...(await tx
      .select({ id: cardEntities.cardId })
      .from(cardEntities)
      .where(inArray(cardEntities.entityId, entityIds))),
    ...(eventIds.length > 0
      ? await tx
          .select({ id: cardEvents.cardId })
          .from(cardEvents)
          .where(inArray(cardEvents.eventId, eventIds))
      : []),
  ]);
  const taskIds = unique(
    await tx
      .select({ id: taskEntities.taskId })
      .from(taskEntities)
      .where(inArray(taskEntities.entityId, entityIds)),
  );

  // Cards first (cascade: actions, links, failure cards of those actions),
  // then tasks (cascade: task_due cards), events (cascade: contents, links,
  // playbook examples; set null on source references) and the entities.
  const deletedCards = await deleteByIds(tx, cards, cardIds);
  const deletedTasks = await deleteByIds(tx, tasks, taskIds);
  const deletedEvents = await deleteByIds(tx, events, eventIds);
  const deletedEntities = await deleteByIds(tx, entities, entityIds);

  const result: ForgetResult = {
    entities: deletedEntities,
    events: deletedEvents,
    cards: deletedCards,
    tasks: deletedTasks,
  };
  await writeAudit(tx, {
    actor,
    context,
    action: 'entity.forgotten',
    objectType: 'entities',
    objectId: entityId,
    metadata: { deleted: result },
  });
  return result;
}

type Deletable = typeof cards | typeof tasks | typeof events | typeof entities;

async function deleteByIds(tx: TenantTransaction, table: Deletable, rowIds: string[]) {
  if (rowIds.length === 0) return 0;
  const rows = await tx.delete(table).where(inArray(table.id, rowIds)).returning({ id: table.id });
  return rows.length;
}
