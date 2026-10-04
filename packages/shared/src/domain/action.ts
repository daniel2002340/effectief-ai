import { z } from 'zod';
import { actorSchema, auditContextSchema } from './audit.ts';
import { centsSchema, vatRateBpsSchema } from './money.ts';
import {
  type ActionType,
  actionErrorCodes,
  actionStatuses,
  actionTypes,
  type ConnectionProvider,
} from './status.ts';

// The action types: per type the input and result schemas, the providers that
// can execute it, and what an edit after executing does. Preliminary shapes: they are tightened per integration once a real provider
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

const emailReplyInput = z.strictObject({
  to: z.array(emailAddress).min(1).max(50),
  cc: z.array(emailAddress).max(50).default([]),
  subject: z.string().trim().min(1).max(500),
  bodyText: z.string().trim().min(1).max(100_000),
  inReplyToMessageId: providerCode,
});

const moneybirdQuoteInput = z.strictObject({
  providerContactId: providerCode,
  reference: z.string().trim().max(200).optional(),
  lines: z.array(quoteLineSchema).min(1).max(100),
  validUntil: z.iso.date().optional(),
});

const invoiceReminderInput = z.strictObject({
  providerInvoiceId: providerCode,
  message: z.string().trim().max(5000).optional(),
});

const paymentLinkInput = z.strictObject({
  totalExclVatCents: centsSchema.positive(),
  vatRateBps: vatRateBpsSchema,
  description: z.string().trim().min(1).max(255),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});

/**
 * What happens when an executed action is edited and executed again:
 * - `update`: the same provider object is updated (a quote, a payment link);
 * - `final`: it cannot be changed (a sent mail), so `executed → concept` is
 *   refused, in transitionAction() and by the trigger actions_final_guard.
 */
export const afterExecuteModes = ['update', 'final'] as const;
export type AfterExecuteMode = (typeof afterExecuteModes)[number];

interface ActionDefinition {
  /** actions.proposed_input / actions.input. */
  input: z.ZodType;
  /** actions.result: minimal provider metadata after executing, no content. */
  result: z.ZodType;
  /** Which connections can execute this type. */
  providers: readonly ConnectionProvider[];
  afterExecute: AfterExecuteMode;
}

/** Every action type the pipeline knows (#004). A new type starts here. */
export const actionRegistry = {
  'email.reply': {
    input: emailReplyInput,
    result: z.strictObject({ providerThreadId: providerCode.optional() }),
    providers: ['gmail', 'outlook'],
    afterExecute: 'final',
  },
  'moneybird.quote': {
    input: moneybirdQuoteInput,
    result: z.strictObject({ documentNumber: providerCode.optional() }),
    providers: ['moneybird'],
    afterExecute: 'update',
  },
  'moneybird.invoice_reminder': {
    input: invoiceReminderInput,
    result: z.strictObject({}),
    providers: ['moneybird'],
    afterExecute: 'final',
  },
  'mollie.payment_link': {
    input: paymentLinkInput,
    result: z.strictObject({ expiresAt: z.iso.datetime({ offset: true }).optional() }),
    providers: ['mollie'],
    afterExecute: 'update',
  },
} as const satisfies Record<ActionType, ActionDefinition>;

type Registry = typeof actionRegistry;

export type ActionInput<T extends ActionType = ActionType> = z.infer<Registry[T]['input']>;
export type ActionResult<T extends ActionType = ActionType> = z.infer<Registry[T]['result']>;

/** Types whose executed action cannot be edited; the trigger gets the same list. */
export const finalActionTypes = actionTypes.filter(
  (type) => actionRegistry[type].afterExecute === 'final',
);

const proposeBase = {
  cardId: z.uuid(),
  connectionId: z.uuid(),
  /**
   * Which proposal of this type on this card (1 for the first). A job that
   * proposes again after a retry passes the same number and gets the
   * existing action back, so the idempotency key stays deterministic.
   */
  ordinal: z.int().min(1).max(1000).default(1),
  /** The playbook the proposal followed, if any. */
  playbookId: z.uuid().optional(),
  aiModel: providerCode.optional(),
  aiTraceId: providerCode.optional(),
  actor: actorSchema,
  context: auditContextSchema.optional(),
};

const proposalOfType = <T extends ActionType>(type: T) =>
  z.strictObject({ ...proposeBase, type: z.literal(type), input: actionRegistry[type].input });

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
/** Executing is done by the worker, never by a person or the model. */
const systemActor = z.strictObject({ type: z.literal('system') });

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
  /** An execute job claims the action; only that job may finish it. */
  z.strictObject({
    ...transitionBase,
    to: z.literal('executing'),
    actor: systemActor,
    jobId: providerCode,
  }),
  z.strictObject({
    ...transitionBase,
    to: z.literal('executed'),
    actor: systemActor,
    providerObjectId: providerCode,
    result: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    ...transitionBase,
    to: z.literal('failed'),
    actor: systemActor,
    errorCode: z.enum(actionErrorCodes),
  }),
  /** Edit after executing or after a failure: back to concept, then approve again. */
  z.strictObject({ ...transitionBase, to: z.literal('concept'), actor: userActor }),
]);
export type TransitionActionInput = z.input<typeof transitionActionInputSchema>;
