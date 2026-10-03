import { z } from 'zod';
import { actorSchema, auditContextSchema } from './audit.ts';
import { sourceRefSchema } from './source.ts';

// Playbooks: how the company handles something (docs/data-model.md, playbooks).
// Content is immutable; changing a confirmed playbook is a new version that
// retires the old one when it is confirmed.

const playbookContent = {
  title: z.string().trim().min(1).max(200),
  /** When it applies; this text is embedded. */
  triggerDescription: z.string().trim().min(1).max(2000),
  instruction: z.string().trim().min(1).max(5000),
  /** Text template with placeholders (`{klantnaam}`), never real names. */
  template: z.string().trim().min(1).max(10_000).nullish(),
};

export const playbookScopeSchema = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('company') }),
  z.strictObject({ scope: z.literal('user'), scopeUserId: z.uuid() }),
  z.strictObject({ scope: z.literal('customer'), scopeEntityId: z.uuid() }),
]);
export type PlaybookScopeInput = z.infer<typeof playbookScopeSchema>;

/** A new playbook is always `proposed`, version 1. */
export const createPlaybookInputSchema = z.strictObject({
  ...playbookContent,
  scope: playbookScopeSchema,
  source: sourceRefSchema,
});
export type CreatePlaybookInput = z.input<typeof createPlaybookInputSchema>;

/** A proposed new version of a confirmed playbook; same scope, version + 1. */
export const createPlaybookVersionInputSchema = z.strictObject({
  supersedesId: z.uuid(),
  ...playbookContent,
  source: sourceRefSchema,
});
export type CreatePlaybookVersionInput = z.input<typeof createPlaybookVersionInputSchema>;

/** Confirming, rejecting and retiring are user steps. */
export const reviewPlaybookInputSchema = z.strictObject({
  playbookId: z.uuid(),
  actor: actorSchema.options[0],
  context: auditContextSchema.default({}),
});
export type ReviewPlaybookInput = z.input<typeof reviewPlaybookInputSchema>;

/**
 * A few-shot example. Names are replaced by placeholders in code before this
 * point. The source is cascaded: the example disappears with its mail or action.
 */
export const addPlaybookExampleInputSchema = z
  .strictObject({
    playbookId: z.uuid(),
    sourceEventId: z.uuid().nullish(),
    sourceActionId: z.uuid().nullish(),
    inputExcerpt: z.string().trim().min(1).max(2000),
    outputText: z.string().trim().min(1).max(10_000),
  })
  .refine((example) => example.sourceEventId || example.sourceActionId, {
    message: 'Een voorbeeld heeft een bron: een event of een actie',
    path: ['sourceEventId'],
  });
export type AddPlaybookExampleInput = z.input<typeof addPlaybookExampleInputSchema>;
