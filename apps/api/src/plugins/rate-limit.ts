import fastifyRateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Redis } from 'ioredis';
import { AppError } from '../errors.ts';

export interface RateLimitOptions {
  redis: Redis;
  /** Requests per client IP per minute. */
  max: number;
}

/**
 * Global per-IP limit with counters in Valkey, so all API instances share them.
 *
 * Exempt, by declaration rather than by path:
 * - routes with `config.rateLimit: false` (the health check);
 * - signed webhook routes (`auth: 'hmac'`), which only exist inside
 *   registerWebhookRoutes(). Providers send bursts from a few IPs and retry
 *   on 429, and the signature check already rejects anyone else.
 *
 * When Valkey is unreachable, limited routes fail (fail-closed); exempt
 * routes never touch Valkey and keep working.
 */
export const rateLimit = fp(
  async (app: FastifyInstance, { redis, max }: RateLimitOptions) => {
    // Runs before the plugin's own onRoute hook, which decides per route.
    app.addHook('onRoute', (route) => {
      if (route.config?.auth === 'hmac') {
        route.config = { ...route.config, rateLimit: false };
      }
    });

    await app.register(fastifyRateLimit, {
      global: true,
      max,
      timeWindow: '1 minute',
      redis,
      nameSpace: 'ratelimit:api:',
      skipOnError: false,
      errorResponseBuilder: () => new AppError('RATE_LIMITED'),
    });
  },
  { name: 'rate-limit' },
);
