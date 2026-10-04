import { z } from 'zod';
import { actorSchema, auditContextSchema, connectionPurgeCountsSchema } from './audit.ts';
import { connectionProviders, connectionStatuses, connectionStatusReasons } from './status.ts';

// connections: a linked integration of a tenant, pointing to a Nango
// connection. Tokens live in Nango, never here.

const nangoId = z.string().regex(/^[\w.:-]{1,200}$/);

export const createConnectionInputSchema = z.strictObject({
  provider: z.enum(connectionProviders),
  nangoIntegrationId: nangoId,
  nangoConnectionId: nangoId,
  /** Account at the provider, e.g. a Moneybird administration id. */
  externalAccountId: z
    .string()
    .regex(/^[\w.:@-]{1,200}$/)
    .nullish(),
  /** What the user sees, e.g. the address of the mailbox (personal data). */
  accountLabel: z.string().trim().min(1).max(320).nullish(),
  connectedByUserId: z.uuid().nullish(),
  actor: actorSchema,
  context: auditContextSchema.optional(),
});
export type CreateConnectionInput = z.input<typeof createConnectionInputSchema>;

export const transitionConnectionInputSchema = z.strictObject({
  connectionId: z.uuid(),
  /** The status the caller saw; the update only applies if it still holds. */
  from: z.enum(connectionStatuses),
  to: z.enum(connectionStatuses),
  reason: z.enum(connectionStatusReasons),
  /** Only when purging: how much data was deleted, for the audit entry. */
  deleted: connectionPurgeCountsSchema.optional(),
  actor: actorSchema,
  context: auditContextSchema.optional(),
});
export type TransitionConnectionInput = z.input<typeof transitionConnectionInputSchema>;
