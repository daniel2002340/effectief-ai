import { z } from 'zod';
import { inboxMessageLabels } from './inbox-message.ts';
import { centsSchema, vatRateBpsSchema } from './money.ts';
import { type EventType, eventEntityRoles, eventSources, linkedByValues } from './status.ts';

// events.payload per type: minimal metadata only. IDs, numbers, amounts and
// enums; no free text and no addresses (docs/data-model.md, events). The full
// content of a mail lives in event_contents, which has a retention period.

/** An ID or document number at a provider ("2026-0042"); not free text. */
const providerCode = z.string().regex(/^[\w.:/#-]{1,128}$/);

const emailPayload = z.strictObject({
  attachmentCount: z.int().min(0).max(1000).optional(),
  /** System labels from a fixed list; never names of the user's own labels. */
  labels: z.array(z.enum(inboxMessageLabels)).max(inboxMessageLabels.length).optional(),
  /** From the first sync of a mailbox (14 days back), not newly received. */
  backfill: z.boolean().optional(),
});

/** Snapshot at the time of the event; the current state is fetched live. */
const documentPayload = z.strictObject({
  providerObjectId: providerCode,
  documentNumber: providerCode.optional(),
  totalExclVatCents: centsSchema,
  vatRateBps: vatRateBpsSchema,
});

const paymentPayload = z.strictObject({
  providerPaymentId: providerCode,
  amountCents: centsSchema,
  currency: z.literal('EUR'),
  failureCode: providerCode.optional(),
});

export const eventPayloadSchemas = {
  'email.received': emailPayload,
  'email.sent': emailPayload,
  'quote.sent': documentPayload,
  'quote.accepted': documentPayload,
  'invoice.sent': documentPayload,
  'payment.paid': paymentPayload,
  'payment.failed': paymentPayload,
  'action.executed': z.strictObject({ providerObjectId: providerCode }),
  'note.added': z.strictObject({}),
} satisfies Record<EventType, z.ZodType>;

export type EventPayload<T extends EventType = EventType> = z.infer<
  (typeof eventPayloadSchemas)[T]
>;

/** Metadata of an attachment; the file itself stays with the provider. */
export const attachmentMetaSchema = z.strictObject({
  name: z.string().min(1).max(255),
  mimeType: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/),
  size: z.int().min(0),
  providerAttachmentId: providerCode,
});
export type AttachmentMeta = z.infer<typeof attachmentMetaSchema>;

/** event_contents: the source content, removed after the retention period. */
export const eventContentInputSchema = z.strictObject({
  fromAddress: z.string().max(320).nullish(),
  fromName: z.string().max(320).nullish(),
  toAddresses: z.array(z.string().max(320)).max(500).nullish(),
  ccAddresses: z.array(z.string().max(320)).max(500).nullish(),
  subject: z.string().max(1000).nullish(),
  bodyText: z.string().max(1_000_000).nullish(),
  attachments: z.array(attachmentMetaSchema).max(100).nullish(),
});
export type EventContentInput = z.input<typeof eventContentInputSchema>;

const eventBase = {
  source: z.enum(eventSources),
  externalId: z.string().min(1).max(1000),
  occurredAt: z.date(),
  threadKey: z.string().min(1).max(1000).nullish(),
  /** The connection it came from; null for events from the app itself. */
  connectionId: z.uuid().nullish(),
  /** For `action.executed`: the action that caused it. */
  causedByActionId: z.uuid().nullish(),
};

const eventOfType = <T extends EventType>(type: T) =>
  z.strictObject({ ...eventBase, type: z.literal(type), payload: eventPayloadSchemas[type] });

export const recordEventInputSchema = z.strictObject({
  event: z.discriminatedUnion('type', [
    eventOfType('email.received'),
    eventOfType('email.sent'),
    eventOfType('quote.sent'),
    eventOfType('quote.accepted'),
    eventOfType('invoice.sent'),
    eventOfType('payment.paid'),
    eventOfType('payment.failed'),
    eventOfType('action.executed'),
    eventOfType('note.added'),
  ]),
  content: eventContentInputSchema.optional(),
});
export type RecordEventInput = z.input<typeof recordEventInputSchema>;

export const linkEventEntityInputSchema = z.strictObject({
  eventId: z.uuid(),
  entityId: z.uuid(),
  role: z.enum(eventEntityRoles),
  linkedBy: z.enum(linkedByValues),
});
export type LinkEventEntityInput = z.input<typeof linkEventEntityInputSchema>;

/** A short AI summary; it stays after the source content has expired. */
export const eventSummarySchema = z.string().trim().min(1).max(2000);
