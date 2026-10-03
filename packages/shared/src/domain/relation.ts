import { z } from 'zod';
import { sourceRefSchema } from './source.ts';
import { relationTypes } from './status.ts';

/**
 * A new relation always starts as `proposed`, also when a user enters it:
 * confirming is a separate step with its own audit entry.
 */
export const createRelationInputSchema = z
  .strictObject({
    fromEntityId: z.uuid(),
    toEntityId: z.uuid(),
    type: z.enum(relationTypes),
    validFrom: z.date().optional(),
    source: sourceRefSchema,
  })
  .refine((input) => input.fromEntityId !== input.toEntityId, {
    message: 'Een relatie verbindt twee verschillende entiteiten',
    path: ['toEntityId'],
  });
export type CreateRelationInput = z.input<typeof createRelationInputSchema>;
