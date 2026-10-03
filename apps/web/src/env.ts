import { z } from 'zod';

/** Variables baked into the bundle at build time. Validated in vite.config.ts too. */
export const webEnvSchema = z.object({
  /** Same-origin path where the API is served, e.g. `/api` (decision #021). */
  VITE_API_BASE_PATH: z.string().regex(/^\/[a-z0-9/_-]*[a-z0-9_-]$/),
});

/** Only needed by the dev server, which proxies the API path to this URL. */
export const webDevEnvSchema = z.object({
  WEB_DEV_API_TARGET: z.url(),
});
