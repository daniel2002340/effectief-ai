import { z } from 'zod';

// Nango configuration (docs/integrations.md §7.1). Integration IDs and the API
// URL are constants (./constants.ts), the same in every environment.

/** The environment names in the Nango dashboard. */
const nangoEnvironments = ['staging', 'prod'] as const;

/**
 * An environment API key or the webhook signing key. Nango shows UUIDs; the
 * check stays loose on the exact form so a new key format does not stop the
 * app, but refuses empty values and whitespace.
 */
const nangoKey = z.string().regex(/^[A-Za-z0-9_-]{20,200}$/, 'Not a Nango key');

/**
 * Where Nango sends the webhooks of connections made here: `none` (the
 * environment's URLs, the default on staging and production) or a tunnel URL
 * for local development (§7.4).
 */
const webhookUrlOverride = z.union([
  z.literal('none'),
  z
    .url({ protocol: /^https$/ })
    .refine((url) => new URL(url).pathname === '/webhooks/nango', 'Must end with /webhooks/nango'),
]);

export const nangoEnvSchema = z.object({
  NANGO_ENVIRONMENT: z.enum(nangoEnvironments),
  NANGO_SECRET_KEY: nangoKey,
  NANGO_WEBHOOK_SIGNING_KEY: nangoKey,
  NANGO_WEBHOOK_URL_OVERRIDE: webhookUrlOverride,
});
export type NangoEnv = z.infer<typeof nangoEnvSchema>;

/**
 * Production talks to Nango's `prod` environment and nothing else does; on
 * staging and production no connection may send its webhooks elsewhere.
 * Spreading `.shape` into another schema drops refinements, so every env
 * schema with these variables adds this check itself, as with monitoring.
 */
export function requireNangoEnvironment() {
  return (env: Record<string, unknown>, ctx: z.RefinementCtx) => {
    const deployed =
      env.SENTRY_ENVIRONMENT === 'staging' || env.SENTRY_ENVIRONMENT === 'production';
    const expected = env.SENTRY_ENVIRONMENT === 'production' ? 'prod' : 'staging';
    if (env.NANGO_ENVIRONMENT !== undefined && env.NANGO_ENVIRONMENT !== expected) {
      ctx.addIssue({
        code: 'custom',
        message: `Must be ${expected} when SENTRY_ENVIRONMENT is ${String(env.SENTRY_ENVIRONMENT)}`,
        path: ['NANGO_ENVIRONMENT'],
      });
    }
    if (
      deployed &&
      env.NANGO_WEBHOOK_URL_OVERRIDE !== undefined &&
      env.NANGO_WEBHOOK_URL_OVERRIDE !== 'none'
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Must be none on staging and production',
        path: ['NANGO_WEBHOOK_URL_OVERRIDE'],
      });
    }
  };
}
