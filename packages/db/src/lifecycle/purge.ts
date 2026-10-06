import {
  type ConnectionLifecycleInput,
  type ConnectionPurgeCounts,
  connectionLifecycleInputSchema,
  connectionTransitions,
} from '@effectief/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { type Connection, getConnection, transitionConnection } from '../feed/connections.ts';
import { assertTransition } from '../feed/transition.ts';
import {
  actions,
  cardEvents,
  cards,
  documents,
  entities,
  entityExternalRefs,
  eventEntities,
  events,
  syncCursors,
} from '../schema/index.ts';
import type { TenantTransaction } from '../with-tenant.ts';

// Disconnecting a connection (docs/data-model.md connections, §6.3): the user
// disconnects (→ revoked), then a job deletes the data that came through it
// (→ purged). The connection row stays as a tombstone for audit and for late
// webhooks. The purge job deletes the connection at Nango first (§5.3).

const unique = (rows: { id: string }[]) => [...new Set(rows.map((row) => row.id))];

/**
 * The user disconnects: an active or expired connection becomes revoked.
 * Idempotent: an already revoked or purged connection is returned as it is.
 * Returns undefined when the connection does not exist for this tenant.
 */
export async function disconnectConnection(
  tx: TenantTransaction,
  input: ConnectionLifecycleInput,
): Promise<Connection | undefined> {
  const { connectionId, actor, context } = connectionLifecycleInputSchema.parse(input);
  const connection = await getConnection(tx, connectionId);
  if (!connection || connection.status === 'revoked' || connection.status === 'purged') {
    return connection;
  }
  return transitionConnection(tx, {
    connectionId,
    from: connection.status,
    to: 'revoked',
    reason: 'user_disconnected',
    actor,
    context,
  });
}

export type PurgeResult =
  | { purged: true; connection: Connection; deleted: ConnectionPurgeCounts }
  | { purged: false; connection: Connection | undefined };

/**
 * Deletes what came in through a revoked (or expired) connection and marks it
 * purged, all in the caller's transaction:
 * - cards about its events, cards with an action through it and its
 *   connection_problem cards (cascade: their actions);
 * - its events (cascade: contents, links, playbook examples);
 * - its external references and its documents (cascade: chunks, embeddings);
 * - its sync cursors;
 * - entities that only existed because of it: nothing links to them anymore
 *   and the user confirmed nothing about them.
 * An active connection is refused (TransitionError); disconnect it first.
 * A purged or unknown connection returns `purged: false`.
 */
export async function purgeConnection(
  tx: TenantTransaction,
  input: ConnectionLifecycleInput,
): Promise<PurgeResult> {
  const { connectionId, actor, context } = connectionLifecycleInputSchema.parse(input);
  const connection = await getConnection(tx, connectionId);
  if (!connection || connection.status === 'purged') return { purged: false, connection };
  // Before deleting anything: an active connection cannot be purged.
  assertTransition('connections', connectionTransitions, connection.status, 'purged');

  const eventIds = unique(
    await tx.select({ id: events.id }).from(events).where(eq(events.connectionId, connectionId)),
  );
  const candidateEntityIds = unique([
    ...(await tx
      .select({ id: entityExternalRefs.entityId })
      .from(entityExternalRefs)
      .where(eq(entityExternalRefs.connectionId, connectionId))),
    ...(eventIds.length > 0
      ? await tx
          .select({ id: eventEntities.entityId })
          .from(eventEntities)
          .where(inArray(eventEntities.eventId, eventIds))
      : []),
  ]);
  const cardIds = unique([
    ...(eventIds.length > 0
      ? await tx
          .select({ id: cardEvents.cardId })
          .from(cardEvents)
          .where(inArray(cardEvents.eventId, eventIds))
      : []),
    ...(await tx
      .select({ id: actions.cardId })
      .from(actions)
      .where(eq(actions.connectionId, connectionId))),
    ...(await tx.select({ id: cards.id }).from(cards).where(eq(cards.connectionId, connectionId))),
  ]);

  const deletedCards = cardIds.length
    ? await tx.delete(cards).where(inArray(cards.id, cardIds)).returning({ id: cards.id })
    : [];
  const deletedEvents = await tx
    .delete(events)
    .where(eq(events.connectionId, connectionId))
    .returning({ id: events.id });
  const deletedRefs = await tx
    .delete(entityExternalRefs)
    .where(eq(entityExternalRefs.connectionId, connectionId))
    .returning({ id: entityExternalRefs.id });
  const deletedDocuments = await tx
    .delete(documents)
    .where(eq(documents.connectionId, connectionId))
    .returning({ id: documents.id });
  // The position in Nango's record stream means nothing once the connection is gone there.
  await tx.delete(syncCursors).where(eq(syncCursors.connectionId, connectionId));
  const deletedEntities = candidateEntityIds.length
    ? await tx
        .delete(entities)
        .where(and(inArray(entities.id, candidateEntityIds), orphaned))
        .returning({ id: entities.id })
    : [];

  const deleted: ConnectionPurgeCounts = {
    events: deletedEvents.length,
    externalRefs: deletedRefs.length,
    documents: deletedDocuments.length,
    cards: deletedCards.length,
    entities: deletedEntities.length,
  };
  const purged = await transitionConnection(tx, {
    connectionId,
    from: connection.status,
    to: 'purged',
    reason: 'data_purged',
    deleted,
    actor,
    context,
  });
  return { purged: true, connection: purged, deleted };
}

/**
 * An entity that nothing holds on to anymore: no events, references, cards,
 * tasks or documents, no knowledge a user confirmed, no identifier a user
 * entered, and no duplicates merged into it. Such an entity only existed
 * because of the purged connection.
 */
const orphaned = sql`
  not exists (select 1 from event_entities x where x.entity_id = ${entities.id})
  and not exists (select 1 from entity_external_refs x where x.entity_id = ${entities.id})
  and not exists (select 1 from card_entities x where x.entity_id = ${entities.id})
  and not exists (select 1 from task_entities x where x.entity_id = ${entities.id})
  and not exists (select 1 from document_entities x where x.entity_id = ${entities.id})
  and not exists (select 1 from facts x
                   where x.entity_id = ${entities.id} and x.status = 'confirmed')
  and not exists (select 1 from relations x
                   where (x.from_entity_id = ${entities.id} or x.to_entity_id = ${entities.id})
                     and x.status = 'confirmed')
  and not exists (select 1 from playbooks x
                   where x.scope_entity_id = ${entities.id} and x.status in ('confirmed', 'retired'))
  and not exists (select 1 from entity_identifiers x
                   where x.entity_id = ${entities.id} and x.source_type = 'user')
  and not exists (select 1 from entities x where x.merged_into_id = ${entities.id})
`;
