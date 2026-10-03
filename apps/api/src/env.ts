import { databaseEnvSchema } from '@effectief/db';
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

export const apiEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
  API_HOST: z.string().min(1),
  API_PORT: z.coerce.number().int().min(1).max(65535),
  API_TRUST_PROXY: trustProxySchema,
  DATABASE_URL: databaseEnvSchema.shape.DATABASE_URL,
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;
