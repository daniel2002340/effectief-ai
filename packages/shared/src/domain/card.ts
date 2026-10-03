import { z } from 'zod';
import { actorSchema, auditContextSchema } from './audit.ts';
import { centsSchema } from './money.ts';
import { type CardKind, cardStatuses, connectionStatusReasons } from './status.ts';

// cards.payload per kind. Structure for the UI, not a copy of the source:
// IDs, amounts and enums. Free text (title, summary) has its own columns.

const providerCode = z.string().regex(/^[\w.:/#-]{1,128}$/);

/** An AI proposal for a task; the task only exists once the user accepts it. */
const suggestedTaskSchema = z.strictObject({
  title: z.string().trim().min(1).max(300),
  dueAt: z.iso.datetime({ offset: true }).optional(),
});

const withSuggestedTask = { suggestedTask: suggestedTaskSchema.optional() };

export const cardPayloadSchemas = {
  email_reply: z.strictObject({ ...withSuggestedTask }),
  quote_request: z.strictObject({ ...withSuggestedTask }),
  payment_overdue: z.strictObject({
    providerInvoiceId: providerCode,
    invoiceNumber: providerCode.optional(),
    openAmountCents: centsSchema,
    daysOverdue: z.int().min(0),
  }),
  connection_problem: z.strictObject({ reason: z.enum(connectionStatusReasons) }),
  knowledge_review: z.strictObject({}),
  task_due: z.strictObject({}),
  insight: z.strictObject({}),
} satisfies Record<CardKind, z.ZodType>;

export type CardPayload<K extends CardKind = CardKind> = z.infer<(typeof cardPayloadSchemas)[K]>;

const cardBase = {
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(2000).nullish(),
  priority: z.int().min(0).max(3).default(1),
  /** E.g. `thread:<thread_key>`; at most one open card per key. */
  dedupeKey: z.string().min(1).max(500).nullish(),
  eventIds: z.array(z.uuid()).max(100).default([]),
  entityIds: z.array(z.uuid()).max(50).default([]),
  aiModel: providerCode.optional(),
  aiTraceId: providerCode.optional(),
  actor: actorSchema,
  context: auditContextSchema.optional(),
};

const cardOfKind = <K extends CardKind>(kind: K) =>
  z.strictObject({ ...cardBase, kind: z.literal(kind), payload: cardPayloadSchemas[kind] });

export const createCardInputSchema = z.discriminatedUnion('kind', [
  cardOfKind('email_reply'),
  cardOfKind('quote_request'),
  cardOfKind('payment_overdue'),
  cardOfKind('connection_problem').extend({ connectionId: z.uuid() }),
  cardOfKind('knowledge_review'),
  cardOfKind('task_due').extend({ taskId: z.uuid() }),
  cardOfKind('insight'),
]);
export type CreateCardInput = z.input<typeof createCardInputSchema>;

export const linkCardInputSchema = z.strictObject({
  cardId: z.uuid(),
  eventIds: z.array(z.uuid()).max(100).default([]),
  entityIds: z.array(z.uuid()).max(50).default([]),
});
export type LinkCardInput = z.input<typeof linkCardInputSchema>;

/**
 * `from` is the status the caller saw; the update only applies if it still
 * holds. Whether `from → to` is allowed is checked by transitionCard().
 */
const transitionBase = {
  cardId: z.uuid(),
  from: z.enum(cardStatuses),
  actor: actorSchema,
  context: auditContextSchema.optional(),
};

export const transitionCardInputSchema = z.discriminatedUnion('to', [
  z.strictObject({ ...transitionBase, to: z.literal('snoozed'), snoozedUntil: z.date() }),
  z.strictObject({ ...transitionBase, to: z.enum(['open', 'done', 'dismissed', 'expired']) }),
]);
export type TransitionCardInput = z.input<typeof transitionCardInputSchema>;
