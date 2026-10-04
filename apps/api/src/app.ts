import { randomUUID } from 'node:crypto';
import type { Database } from '@effectief/db';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { createAuth, resolveSession } from './auth/auth.ts';
import { authRoutes } from './auth/routes.ts';
import type { ApiEnv } from './env.ts';
import { loggerOptions } from './logger.ts';
import type { EnqueueExecuteAction } from './orpc/actions.ts';
import { orpcRoutes } from './orpc/plugin.ts';
import { createRouter } from './orpc/router.ts';
import { errorHandler } from './plugins/error-handler.ts';
import { jsonOnly } from './plugins/json-only.ts';
import { rateLimit } from './plugins/rate-limit.ts';
import { registerWebhookRoutes } from './plugins/raw-body.ts';
import { routeAuth } from './plugins/route-auth.ts';
import { healthRoutes } from './routes/health.ts';
import { webhookRoutes } from './routes/webhooks.ts';

export interface AppDependencies {
  env: ApiEnv;
  redis: Redis;
  databases: {
    /** As app_runtime: customer data, always via withTenant(). */
    app: Database;
    /** As auth_runtime: only Better Auth uses this (decision #031). */
    auth: Database;
  };
  /** Puts an approved action on the execute queue (BullMQ in main.ts). */
  enqueueExecuteAction: EnqueueExecuteAction;
  /** Requests per IP per minute; lowered in tests. */
  rateLimitMax?: number;
  /** Sign-in and sign-up attempts per IP per window. */
  loginRateLimit?: { max: number; timeWindow: string };
  /** Routes inside the /webhooks scope; tests pass their own. */
  webhooks?: (scope: FastifyInstance) => Promise<void>;
}

/** Builds the API without listening, so tests can use `app.inject()`. */
export async function buildApp({
  env,
  redis,
  databases,
  enqueueExecuteAction,
  rateLimitMax = 300,
  loginRateLimit = { max: 10, timeWindow: '15 minutes' },
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
  await app.register(jsonOnly);

  await app.register(helmet);
  await app.register(rateLimit, { redis, max: rateLimitMax });

  const auth = createAuth({ env, authDb: databases.auth, appDb: databases.app, log: app.log });
  const router = createRouter({
    appDb: databases.app,
    resolveSession: (headers) => resolveSession(auth, databases.auth, headers),
    enqueueExecuteAction,
  });

  await app.register(healthRoutes);
  await app.register(authRoutes, { auth, env, loginRateLimit });
  await app.register(orpcRoutes, { router });
  await registerWebhookRoutes(app, webhooks);

  return app;
}

/** Fastify takes a hop count as a function: trust the first n hops from our side. */
function toTrustProxy(value: ApiEnv['API_TRUST_PROXY']) {
  if (typeof value === 'number') return (_address: string, hop: number) => hop < value;
  return value;
}
