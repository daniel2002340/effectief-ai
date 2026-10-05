import { monitoringEnvSchema, requireMonitoring } from '@effectief/shared';
import { z } from 'zod';

/** Variables baked into the bundle at build time. Validated in vite.config.ts too. */
export const webEnvSchema = z
  .object({
    /** Same-origin path where the API is served, e.g. `/api` (decision #021). */
    VITE_API_BASE_PATH: z.string().regex(/^\/[a-z0-9/_-]*[a-z0-9_-]$/),
    /** Sentry for the browser (decision #055); `disabled` turns it off explicitly. */
    VITE_SENTRY_DSN: monitoringEnvSchema.shape.SENTRY_DSN,
    VITE_SENTRY_ENVIRONMENT: monitoringEnvSchema.shape.SENTRY_ENVIRONMENT,
    /** Git SHA of the build; the release that source maps are uploaded for. */
    VITE_APP_RELEASE: monitoringEnvSchema.shape.APP_RELEASE,
  })
  .superRefine(
    requireMonitoring({ dsn: 'VITE_SENTRY_DSN', environment: 'VITE_SENTRY_ENVIRONMENT' }),
  );

/** Only needed by the dev server, which proxies the API path to this URL. */
export const webDevEnvSchema = z.object({
  WEB_DEV_API_TARGET: z.url(),
});
