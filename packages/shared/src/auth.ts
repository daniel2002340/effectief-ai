import { z } from 'zod';

/**
 * Every route declares how it is authenticated. There is no default and no
 * exception list: the API refuses to start when a route has no auth type.
 *
 * - `session`: a logged-in user; the tenant comes from the session.
 * - `hmac`: a signed webhook; the signature is checked on the raw body.
 * - `public`: deliberately open (health checks and the like).
 */
export const authTypeSchema = z.enum(['session', 'hmac', 'public']);
export type AuthType = z.infer<typeof authTypeSchema>;

/** Contract procedures are called by our own clients, never signed webhooks. */
export const contractAuthTypeSchema = authTypeSchema.exclude(['hmac']);
export type ContractAuthType = z.infer<typeof contractAuthTypeSchema>;
