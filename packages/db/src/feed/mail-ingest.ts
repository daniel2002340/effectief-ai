import {
  type EventSource,
  type RecordEventInput,
  type SyncModel,
  syncModels,
} from '@effectief/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { recordEvent } from '../memory/events.ts';
import {
  connections,
  entityIdentifiers,
  eventContents,
  eventEntities,
  events,
  syncCursors,
} from '../schema/index.ts';
import type { TenantTransaction } from '../with-tenant.ts';
import { writeAudit } from './audit.ts';

// Taking in one page of mail records from Nango (docs/integrations.md §4.2,
// #076): in one transaction the events, their content, the links to known
// contacts, the new cursor and the audit counts. The caller fetches the page
// outside any transaction; this function checks that no other ingest moved
// the cursor in the meantime.

const cursorKey = z.strictObject({ connectionId: z.uuid(), model: z.enum(syncModels) });

/** The cursor to read from; creates the row on first use. */
export async function getSyncCursor(
  tx: TenantTransaction,
  input: { connectionId: string; model: SyncModel },
): Promise<string | null> {
  const { connectionId, model } = cursorKey.parse(input);
  await tx.insert(syncCursors).values({ connectionId, model }).onConflictDoNothing();
  const [row] = await tx
    .select({ cursor: syncCursors.cursor })
    .from(syncCursors)
    .where(and(eq(syncCursors.connectionId, connectionId), eq(syncCursors.model, model)));
  return row?.cursor ?? null;
}

/** A record of the page, already parsed and normalized by the caller. */
export type MailPageItem =
  | {
      kind: 'message';
      event: RecordEventInput;
      /** Normalized addresses to link to entities that already have them. */
      senders: string[];
      recipients: string[];
    }
  /** Deleted or marked spam at the source: the content goes, the event stays (§4.5). */
  | { kind: 'removed'; source: EventSource; externalId: string }
  /** Refused by the schema; counted, never stored. */
  | { kind: 'invalid' }
  /** Already pruned at Nango: nothing left to read. */
  | { kind: 'skipped' };

export interface ApplyMailPageInput {
  connectionId: string;
  model: SyncModel;
  /** The cursor this page was read from; the page is refused if it moved. */
  fromCursor: string | null;
  /** The cursor of the page's last record. */
  toCursor: string;
  items: MailPageItem[];
  context?: { jobId?: string };
}

export type ApplyMailPageResult =
  | { applied: false }
  | { applied: true; records: number; created: number; removed: number; invalid: number };

export async function applyMailPage(
  tx: TenantTransaction,
  input: ApplyMailPageInput,
): Promise<ApplyMailPageResult> {
  const { connectionId, model } = cursorKey.parse({
    connectionId: input.connectionId,
    model: input.model,
  });
  // One ingest per connection: lock the row, and refuse when it moved.
  const [locked] = await tx
    .select({ cursor: syncCursors.cursor })
    .from(syncCursors)
    .where(and(eq(syncCursors.connectionId, connectionId), eq(syncCursors.model, model)))
    .for('update');
  if (!locked || locked.cursor !== input.fromCursor) return { applied: false };

  const [connection] = await tx
    .select({ provider: connections.provider, status: connections.status })
    .from(connections)
    .where(eq(connections.id, connectionId));
  // Expired or revoked in the meantime: take in nothing more (§5.1).
  if (connection?.status !== 'active') return { applied: false };

  const counts = { records: input.items.length, created: 0, removed: 0, invalid: 0 };
  for (const item of input.items) {
    if (item.kind === 'invalid') counts.invalid += 1;
    if (item.kind === 'removed') {
      counts.removed += await removeEventContent(tx, item.source, item.externalId);
    }
    if (item.kind === 'message') {
      const { event, created } = await recordEvent(tx, item.event);
      if (!created) continue;
      counts.created += 1;
      await linkKnownAddresses(tx, event.id, 'sender', item.senders);
      await linkKnownAddresses(tx, event.id, 'recipient', item.recipients);
    }
  }

  await tx
    .update(syncCursors)
    .set({ cursor: input.toCursor, updatedAt: sql`now()` })
    .where(and(eq(syncCursors.connectionId, connectionId), eq(syncCursors.model, model)));
  await tx
    .update(connections)
    .set({ lastSyncedAt: sql`now()` })
    .where(eq(connections.id, connectionId));

  const context = input.context ?? {};
  await writeAudit(tx, {
    actor: { type: 'system' },
    context,
    action: 'mail.ingested',
    objectType: 'connections',
    objectId: connectionId,
    metadata: { provider: connection.provider, ...counts },
  });
  if (counts.removed > 0) {
    await writeAudit(tx, {
      actor: { type: 'system' },
      context,
      action: 'mail.content_removed',
      objectType: 'event_contents',
      objectId: null,
      metadata: { provider: connection.provider, count: counts.removed },
    });
  }
  return { applied: true, ...counts };
}

/** Removes the source content of one mail; the event stays. Returns 1 if there was content. */
async function removeEventContent(tx: TenantTransaction, source: EventSource, externalId: string) {
  const deleted = await tx
    .delete(eventContents)
    .where(
      inArray(
        eventContents.eventId,
        tx
          .select({ id: events.id })
          .from(events)
          .where(and(eq(events.source, source), eq(events.externalId, externalId))),
      ),
    )
    .returning({ eventId: eventContents.eventId });
  return deleted.length;
}

/** Links addresses that already belong to an entity; never creates entities (data-model §6.1). */
async function linkKnownAddresses(
  tx: TenantTransaction,
  eventId: string,
  role: 'sender' | 'recipient',
  addresses: string[],
) {
  if (addresses.length === 0) return;
  const known = await tx
    .selectDistinct({ entityId: entityIdentifiers.entityId })
    .from(entityIdentifiers)
    .where(and(eq(entityIdentifiers.kind, 'email'), inArray(entityIdentifiers.value, addresses)));
  if (known.length === 0) return;
  await tx
    .insert(eventEntities)
    .values(known.map(({ entityId }) => ({ eventId, entityId, role, linkedBy: 'rule' as const })))
    .onConflictDoNothing();
}
