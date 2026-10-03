import { z } from 'zod';
import { actorSchema, auditContextSchema } from './audit.ts';
import { centsSchema, vatRateBpsSchema } from './money.ts';
import { type ActionType, actionStatuses, type ConnectionProvider } from './status.ts';

// actions.proposed_input / actions.input and actions.result per type.
// Preliminary shapes: they are tightened per integration once a real provider
// payload is captured as a fixture (CLAUDE.md, integrations). Signature and
// language are added in code when executing, not stored here.

const providerCode = z.string().regex(/^[\w.:/#-]{1,128}$/);
const emailAddress = z.email().max(320);

const quoteLineSchema = z.strictObject({
  description: z.string().trim().min(1).max(1000),
  /** Decimal as a string ("1.5" hours), so no float ever touches an amount. */
  quantity: z.string().regex(/^\d{1,6}(\.\d{1,3})?$/),
  unitPriceExclVatCents: centsSchema,
  vatRateBps: vatRateBpsSchema,
});

export const actionInputSchemas = {
  'email.reply': z.strictObject({
    to: z.array(emailAddress).min(1).max(50),
    cc: z.array(emailAddress).max(50).default([]),
    subject: z.string().trim().min(1).max(500),
    bodyText: z.string().trim().min(1).max(100_000),
    inReplyToMessageId: providerCode,
  }),
  'moneybird.quote': z.strictObject({
    providerContactId: providerCode,
    reference: z.string().trim().max(200).optional(),
    lines: z.array(quoteLineSchema).min(1).max(100),
    validUntil: z.iso.date().optional(),
  }),
  'moneybird.invoice_reminder': z.strictObject({
    providerInvoiceId: providerCode,
    message: z.string().trim().max(5000).optional(),
  }),
  'mollie.payment_link': z.strictObject({
    totalExclVatCents: centsSchema.positive(),
    vatRateBps: vatRateBpsSchema,
    description: z.string().trim().min(1).max(255),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
  }),
} satisfies Record<ActionType, z.ZodType>;

export type ActionInput<T extends ActionType = ActionType> = z.infer<
  (typeof actionInputSchemas)[T]
>;

/** Minimal provider metadata after executing: numbers and status, no content. */
export const actionResultSchemas = {
  'email.reply': z.strictObject({ providerThreadId: providerCode.optional() }),
  'moneybird.quote': z.strictObject({ documentNumber: providerCode.optional() }),
  'moneybird.invoice_reminder': z.strictObject({}),
  'mollie.payment_link': z.strictObject({ expiresAt: z.iso.datetime({ offset: true }).optional() }),
} satisfies Record<ActionType, z.ZodType>;

export type ActionResult<T extends ActionType = ActionType> = z.infer<
  (typeof actionResultSchemas)[T]
>;

/** Which connections can execute an action type. */
export const actionProviders = {
  'email.reply': ['gmail', 'outlook'],
  'moneybird.quote': ['moneybird'],
  'moneybird.invoice_reminder': ['moneybird'],
  'mollie.payment_link': ['mollie'],
} as const satisfies Record<ActionType, readonly ConnectionProvider[]>;

const proposeBase = {
  cardId: z.uuid(),
  connectionId: z.uuid(),
  /**
   * Which proposal of this type on this card (1 for the first). A job that
   * proposes again after a retry passes the same number and gets the
   * existing action back, so the idempotency key stays deterministic.
   */
  ordinal: z.int().min(1).max(1000).default(1),
  aiModel: providerCode.optional(),
  aiTraceId: providerCode.optional(),
  actor: actorSchema,
  context: auditContextSchema.optional(),
};

const proposalOfType = <T extends ActionType>(type: T) =>
  z.strictObject({ ...proposeBase, type: z.literal(type), input: actionInputSchemas[type] });

export const proposeActionInputSchema = z.discriminatedUnion('type', [
  proposalOfType('email.reply'),
  proposalOfType('moneybird.quote'),
  proposalOfType('moneybird.invoice_reminder'),
  proposalOfType('mollie.payment_link'),
]);
export type ProposeActionInput = z.input<typeof proposeActionInputSchema>;

/**
 * `from` is the status the caller saw; the update only applies if it still
 * holds. Whether `from → to` is allowed is checked by transitionAction().
 * `input` and `result` are validated against the schema of the action's type.
 */
const transitionBase = {
  actionId: z.uuid(),
  from: z.enum(actionStatuses),
  context: auditContextSchema.optional(),
};

const userActor = z.strictObject({ type: z.literal('user'), userId: z.uuid() });

export const transitionActionInputSchema = z.discriminatedUnion('to', [
  z.strictObject({
    ...transitionBase,
    to: z.literal('approved'),
    /** Only a person approves (CLAUDE.md: the model only proposes). */
    actor: userActor,
    /** The edited input, when the user changed the proposal. */
    input: z.record(z.string(), z.unknown()).optional(),
  }),
  z.strictObject({ ...transitionBase, to: z.literal('rejected'), actor: userActor }),
  z.strictObject({
    ...transitionBase,
    to: z.literal('executed'),
    actor: actorSchema,
    providerObjectId: providerCode,
    result: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    ...transitionBase,
    to: z.literal('failed'),
    actor: actorSchema,
    errorCode: providerCode,
  }),
  /** Edit after executing: back to concept, then approve again. */
  z.strictObject({ ...transitionBase, to: z.literal('concept'), actor: userActor }),
]);
export type TransitionActionInput = z.input<typeof transitionActionInputSchema>;
