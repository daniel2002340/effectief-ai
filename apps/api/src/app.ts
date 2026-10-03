import { randomUUID } from 'node:crypto';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { ApiEnv } from './env.ts';
import { AppError } from './errors.ts';
import { loggerOptions } from './logger.ts';
import { orpcRoutes } from './orpc/plugin.ts';
import { errorHandler } from './plugins/error-handler.ts';
import { routeAuth } from './plugins/route-auth.ts';
import { healthRoutes } from './routes/health.ts';

export interface AppDependencies {
  env: ApiEnv;
  redis: Redis;
  /** Requests per IP per minute; lowered in tests. */
  rateLimitMax?: number;
}

/** Builds the API without listening, so tests can use `app.inject()`. */
export async function buildApp({
  env,
  redis,
  rateLimitMax = 300,
}: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(env),
    genReqId: () => randomUUID(),
    bodyLimit: 1024 * 1024,
  });

  // Must come first: routes registered below are checked by these hooks.
  await app.register(errorHandler);
  await app.register(routeAuth);

  await app.register(helmet);
  await app.register(rateLimit, {
    global: true,
    max: rateLimitMax,
    timeWindow: '1 minute',
    redis,
    nameSpace: 'ratelimit:api:',
    errorResponseBuilder: () => new AppError('RATE_LIMITED'),
  });

  await app.register(healthRoutes);
  await app.register(orpcRoutes);

  return app;
}
