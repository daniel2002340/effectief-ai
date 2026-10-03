import { z } from 'zod';
import { actorSchema, auditContextSchema } from './audit.ts';
import { sourceRefSchema } from './source.ts';

// Facts: durable truths about an entity (docs/data-model.md, facts). The text
// is never overwritten: correcting a fact creates a new one and ends the old
// one with valid_to and superseded_by_id.

/** Normalised key for recognising contradictions, e.g. `preferred_contact_time`. */
export const factAttributeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

export const factStructuredSchema = z.strictObject({
  attribute: factAttributeSchema,
  value: z.union([z.string().trim().min(1).max(500), z.number(), z.boolean()]),
  unit: z.string().trim().min(1).max(50).optional(),
});
export type FactStructured = z.infer<typeof factStructuredSchema>;

/** Without `attribute`, it is taken from `structured` (or, when replacing, from the old fact). */
const factContent = {
  /** Plain language, Dutch. */
  statement: z.string().trim().min(1).max(1000),
  attribute: factAttributeSchema.nullish(),
  structured: factStructuredSchema.nullish(),
};

const sameAttribute = (fact: {
  attribute?: string | null | undefined;
  structured?: FactStructured | null | undefined;
}) =>
  !fact.structured || fact.attribute === undefined || fact.structured.attribute === fact.attribute;

const sameAttributeMessage = {
  message: 'structured.attribute moet gelijk zijn aan attribute',
  path: ['structured', 'attribute'],
};

/** A new fact is always `proposed`; only a user confirms (docs/data-model.md §2). */
export const createFactInputSchema = z
  .strictObject({
    entityId: z.uuid(),
    ...factContent,
    /** 0–1 from the model; for sorting the review only, never an automatic confirmation. */
    confidence: z.number().min(0).max(1).nullish(),
    validFrom: z.date().optional(),
    source: sourceRefSchema,
  })
  .refine(sameAttribute, sameAttributeMessage);
export type CreateFactInput = z.input<typeof createFactInputSchema>;

const userActor = actorSchema.options[0];

/** Confirming and rejecting are user steps. */
export const reviewFactInputSchema = z.strictObject({
  factId: z.uuid(),
  actor: userActor,
  context: auditContextSchema.default({}),
});
export type ReviewFactInput = z.input<typeof reviewFactInputSchema>;

/**
 * A correction by the user ("klopt niet, Jan werkt nu bij Bouw BV"): a new,
 * confirmed fact about the same entity replaces the current one. Without
 * `attribute` the new fact keeps the attribute of the old one.
 */
export const replaceFactInputSchema = z
  .strictObject({
    factId: z.uuid(),
    ...factContent,
    actor: userActor,
    context: auditContextSchema.default({}),
  })
  .refine(sameAttribute, sameAttributeMessage);
export type ReplaceFactInput = z.input<typeof replaceFactInputSchema>;
