import { randomUUID } from 'node:crypto';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { ApiEnv } from './env.ts';
import { loggerOptions } from './logger.ts';
import { orpcRoutes } from './orpc/plugin.ts';
import { errorHandler } from './plugins/error-handler.ts';
import { rateLimit } from './plugins/rate-limit.ts';
import { registerWebhookRoutes } from './plugins/raw-body.ts';
import { routeAuth } from './plugins/route-auth.ts';
import { healthRoutes } from './routes/health.ts';
import { webhookRoutes } from './routes/webhooks.ts';

export interface AppDependencies {
  env: ApiEnv;
  redis: Redis;
  /** Requests per IP per minute; lowered in tests. */
  rateLimitMax?: number;
  /** Routes inside the /webhooks scope; tests pass their own. */
  webhooks?: (scope: FastifyInstance) => Promise<void>;
}

/** Builds the API without listening, so tests can use `app.inject()`. */
export async function buildApp({
  env,
  redis,
  rateLimitMax = 300,
  webhooks = webhookRoutes,
}: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(env),
    genReqId: () => randomUUID(),
    bodyLimit: 1024 * 1024,
    // Which proxies may set X-Forwarded-For; decides the client IP for rate limiting.
    trustProxy: toTrustProxy(env.API_TRUST_PROXY),
  });

  // Must come first: routes registered below are checked by these hooks.
  await app.register(errorHandler);
  await app.register(routeAuth);

  await app.register(helmet);
  await app.register(rateLimit, { redis, max: rateLimitMax });

  await app.register(healthRoutes);
  await app.register(orpcRoutes);
  await registerWebhookRoutes(app, webhooks);

  return app;
}

/** Fastify takes a hop count as a function: trust the first n hops from our side. */
function toTrustProxy(value: ApiEnv['API_TRUST_PROXY']) {
  if (typeof value === 'number') return (_address: string, hop: number) => hop < value;
  return value;
}
