import { authDatabaseEnvSchema, databaseEnvSchema } from '@effectief/db';
import { monitoringEnvSchema } from '@effectief/shared';
import { z } from 'zod';

const ipOrCidr = z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()]);

/**
 * Which proxies may set X-Forwarded-For:
 * - `false`: no proxy, use the socket address;
 * - a number: trust that many proxy hops;
 * - a comma-separated list of proxy IPs or CIDRs.
 * `true` (trust everyone) is refused: clients could then pick their own IP.
 */
export const trustProxySchema = z
  .string()
  .trim()
  .refine((value) => value !== 'true', 'Use a hop count or proxy addresses, not "true"')
  .transform((value, ctx): false | number | string[] => {
    if (value === 'false') return false;
    if (/^\d+$/.test(value)) return Number(value);
    const addresses = value.split(',').map((part) => part.trim());
    for (const address of addresses) {
      if (!ipOrCidr.safeParse(address).success) {
        ctx.addIssue({ code: 'custom', message: `Not an IP or CIDR: ${address}` });
        return z.NEVER;
      }
    }
    return addresses;
  });

/** Who may create an account (decision #062). */
export type SignupAllowlist =
  | { anyone: true }
  | { anyone: false; emails: string[]; domains: string[] };

/**
 * Comma-separated email addresses and `@domain` entries, or exactly `*` for
 * anyone. Required, so open registration is always an explicit choice.
 */
const signupAllowlistSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value, ctx): SignupAllowlist => {
    if (value === '*') return { anyone: true };
    const emails: string[] = [];
    const domains: string[] = [];
    for (const raw of value.split(',')) {
      const entry = raw.trim().toLowerCase();
      if (
        entry.startsWith('@') &&
        z
          .string()
          .regex(/^@[a-z0-9.-]+\.[a-z]{2,}$/)
          .safeParse(entry).success
      ) {
        domains.push(entry.slice(1));
      } else if (z.email().safeParse(entry).success) {
        emails.push(entry);
      } else {
        // The entry itself is not echoed: it can be an email address.
        ctx.addIssue({ code: 'custom', message: 'Each entry must be an email address or @domain' });
        return z.NEVER;
      }
    }
    return { anyone: false, emails, domains };
  });

export function isSignupAllowed(allowlist: SignupAllowlist, email: string): boolean {
  if (allowlist.anyone) return true;
  const normalized = email.trim().toLowerCase();
  const domain = normalized.slice(normalized.lastIndexOf('@') + 1);
  return allowlist.emails.includes(normalized) || allowlist.domains.includes(domain);
}

export const apiEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
    API_HOST: z.string().min(1),
    API_PORT: z.coerce.number().int().min(1).max(65535),
    API_TRUST_PROXY: trustProxySchema,
    DATABASE_URL: databaseEnvSchema.shape.DATABASE_URL,
    DATABASE_AUTH_URL: authDatabaseEnvSchema.shape.DATABASE_AUTH_URL,
    /** Public origin of web and api (same origin, decision #021), e.g. https://app.effectief.ai. */
    APP_ORIGIN: z.url({ protocol: /^https?$/ }).transform((url) => new URL(url).origin),
    /** Signs session cookies. Generate with `openssl rand -base64 32`. */
    BETTER_AUTH_SECRET: z.string().min(32),
    AUTH_SIGNUP_ALLOWLIST: signupAllowlistSchema,
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    ...monitoringEnvSchema.shape,
  })
  .refine((env) => env.NODE_ENV !== 'production' || env.APP_ORIGIN.startsWith('https://'), {
    message: 'APP_ORIGIN must use https in production (secure session cookies)',
    path: ['APP_ORIGIN'],
  });

export type ApiEnv = z.infer<typeof apiEnvSchema>;
