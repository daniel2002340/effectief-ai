import { z } from 'zod';
import { sourceRefSchema } from './source.ts';
import type { EntityType } from './status.ts';

// Entity attributes per type (entities.attributes). Only what a feature needs;
// email and phone live in entity_identifiers, not here (data minimisation).

const shortText = z.string().trim().min(1).max(200);

export const entityAttributesSchemas = {
  contact: z.strictObject({ jobTitle: shortText.optional() }),
  company: z.strictObject({
    website: z
      .url({ protocol: /^https?$/ })
      .max(200)
      .optional(),
  }),
  project: z.strictObject({ address: shortText.optional() }),
} satisfies Record<EntityType, z.ZodType>;

export type EntityAttributes<T extends EntityType = EntityType> = z.infer<
  (typeof entityAttributesSchemas)[T]
>;

const entityName = z.string().trim().min(1).max(200);

export const createEntityInputSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('contact'),
    name: entityName,
    attributes: entityAttributesSchemas.contact.default({}),
  }),
  z.strictObject({
    type: z.literal('company'),
    name: entityName,
    attributes: entityAttributesSchemas.company.default({}),
  }),
  z.strictObject({
    type: z.literal('project'),
    name: entityName,
    attributes: entityAttributesSchemas.project.default({}),
  }),
]);
export type CreateEntityInput = z.input<typeof createEntityInputSchema>;

/**
 * Mail domains shared by many people. An `email_domain` identifier for one of
 * these would link every private sender to one company.
 */
export const publicEmailDomains: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'hotmail.nl',
  'outlook.com',
  'outlook.nl',
  'live.com',
  'live.nl',
  'msn.com',
  'icloud.com',
  'me.com',
  'yahoo.com',
  'proton.me',
  'protonmail.com',
  'ziggo.nl',
  'kpnmail.nl',
  'kpnplanet.nl',
  'planet.nl',
  'home.nl',
  'xs4all.nl',
  'hetnet.nl',
  'casema.nl',
  'chello.nl',
  'upcmail.nl',
  'telfort.nl',
]);

/** Dutch numbers without country code (06…, 020…) become +31…; result is E.164. */
const phoneSchema = z
  .string()
  .transform((value) => value.replace(/[\s().-]/g, ''))
  .transform((value) => value.replace(/^00/, '+').replace(/^0(?=[1-9])/, '+31'))
  .pipe(z.string().regex(/^\+[1-9]\d{6,14}$/));

const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.string().regex(/^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/))
  .refine((domain) => !publicEmailDomains.has(domain), 'Publiek maildomein');

/** Identifier values are normalised, so lookups are exact matches. */
export const identifierValueSchemas = {
  email: z.string().trim().toLowerCase().pipe(z.email()),
  phone: phoneSchema,
  email_domain: domainSchema,
  kvk: z
    .string()
    .trim()
    .pipe(z.string().regex(/^\d{8}$/)),
} as const;

const identifierInput = <K extends keyof typeof identifierValueSchemas>(kind: K) =>
  z.strictObject({ kind: z.literal(kind), value: identifierValueSchemas[kind] });

export const entityIdentifierSchema = z.discriminatedUnion('kind', [
  identifierInput('email'),
  identifierInput('phone'),
  identifierInput('email_domain'),
  identifierInput('kvk'),
]);
export type EntityIdentifier = z.input<typeof entityIdentifierSchema>;

export const addEntityIdentifierInputSchema = z.strictObject({
  entityId: z.uuid(),
  identifier: entityIdentifierSchema,
  source: sourceRefSchema,
});
export type AddEntityIdentifierInput = z.input<typeof addEntityIdentifierInputSchema>;
