import { z } from 'zod';
import { actorSchema, auditContextSchema } from './audit.ts';

// The data lifecycle (docs/data-model.md §6.3, event_contents): forgetting a
// person and purging the data of a disconnected connection.

/** Only an owner may ask for this; the caller checks the role. */
export const forgetEntityInputSchema = z.strictObject({
  entityId: z.uuid(),
  actor: actorSchema,
  context: auditContextSchema.optional(),
});
export type ForgetEntityInput = z.input<typeof forgetEntityInputSchema>;

export const connectionLifecycleInputSchema = z.strictObject({
  connectionId: z.uuid(),
  actor: actorSchema,
  context: auditContextSchema.optional(),
});
export type ConnectionLifecycleInput = z.input<typeof connectionLifecycleInputSchema>;
