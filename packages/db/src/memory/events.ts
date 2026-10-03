import {
  eventSummarySchema,
  type LinkEventEntityInput,
  linkEventEntityInputSchema,
  type RecordEventInput,
  recordEventInputSchema,
} from '@effectief/shared';
import { and, desc, eq, inArray, isNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import { eventContents, eventEntities, events, tenantSettings } from '../schema/index.ts';
import type { TenantTransaction } from '../with-tenant.ts';
import { single } from './source.ts';

export type Event = typeof events.$inferSelect;
export type EventContent = typeof eventContents.$inferSelect;

const idSchema = z.uuid();
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Records an event on the timeline, idempotent on (tenant, source, external_id).
 * A repeat returns the existing event with `created: false` and does not touch
 * its content. Content gets `retain_until` = occurred_at + the tenant's
 * retention period (#037).
 */
export async function recordEvent(tx: TenantTransaction, input: RecordEventInput) {
  const { event, content } = recordEventInputSchema.parse(input);

  const [created] = await tx
    .insert(events)
    .values(event)
    .onConflictDoNothing({ target: [events.tenantId, events.source, events.externalId] })
    .returning();

  if (!created) {
    const existing = single(
      await tx
        .select()
        .from(events)
        .where(and(eq(events.source, event.source), eq(events.externalId, event.externalId))),
    );
    return { event: existing, created: false };
  }

  if (content) {
    const settings = single(
      await tx.select({ days: tenantSettings.contentRetentionDays }).from(tenantSettings),
    );
    await tx.insert(eventContents).values({
      eventId: created.id,
      ...content,
      retainUntil: new Date(event.occurredAt.getTime() + settings.days * DAY_MS),
    });
  }
  return { event: created, created: true };
}

/** Sets the AI summary once; returns false when the event already had one. */
export async function setEventSummary(tx: TenantTransaction, eventId: string, summary: string) {
  const rows = await tx
    .update(events)
    .set({ summary: eventSummarySchema.parse(summary), summarizedAt: new Date() })
    .where(and(eq(events.id, idSchema.parse(eventId)), isNull(events.summary)))
    .returning({ id: events.id });
  return rows.length === 1;
}

export async function linkEventEntity(tx: TenantTransaction, input: LinkEventEntityInput) {
  await tx
    .insert(eventEntities)
    .values(linkEventEntityInputSchema.parse(input))
    .onConflictDoNothing();
}

export async function getEvent(tx: TenantTransaction, eventId: string) {
  const [row] = await tx
    .select()
    .from(events)
    .where(eq(events.id, idSchema.parse(eventId)));
  return row;
}

/** The source content, or undefined when there was none or it has expired. */
export async function getEventContent(tx: TenantTransaction, eventId: string) {
  const [row] = await tx
    .select()
    .from(eventContents)
    .where(eq(eventContents.eventId, idSchema.parse(eventId)));
  return row;
}

const timelineQuerySchema = z.strictObject({
  entityId: z.uuid().optional(),
  before: z.date().optional(),
  limit: z.int().min(1).max(200).default(50),
});

/** Newest first; optionally only events linked to one entity. */
export function listTimeline(
  tx: TenantTransaction,
  query: z.input<typeof timelineQuerySchema> = {},
) {
  const { entityId, before, limit } = timelineQuerySchema.parse(query);
  return tx
    .select()
    .from(events)
    .where(
      and(
        before ? lt(events.occurredAt, before) : undefined,
        entityId
          ? inArray(
              events.id,
              tx
                .select({ id: eventEntities.eventId })
                .from(eventEntities)
                .where(eq(eventEntities.entityId, entityId)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(events.occurredAt), desc(events.id))
    .limit(limit);
}
