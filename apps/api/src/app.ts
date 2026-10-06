import { randomUUID } from 'node:crypto';
import type { Database } from '@effectief/db';
import { createNangoClient, type NangoClient } from '@effectief/integrations/nango';
import { type ReportError, testErrorsEnabled } from '@effectief/shared';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { createAuth, resolveSession } from './auth/auth.ts';
import { authRoutes } from './auth/routes.ts';
import type { ApiEnv } from './env.ts';
import { loggerOptions } from './logger.ts';
import type { EnqueueExecuteAction } from './orpc/actions.ts';
import type { EnqueueConnectAttempt, EnqueuePurgeConnection } from './orpc/connections.ts';
import { orpcRoutes } from './orpc/plugin.ts';
import { createRouter } from './orpc/router.ts';
import type { EnqueueMonitoringTest } from './orpc/test-errors.ts';
import { errorHandler } from './plugins/error-handler.ts';
import { jsonOnly } from './plugins/json-only.ts';
import { rateLimit } from './plugins/rate-limit.ts';
import { registerWebhookRoutes } from './plugins/raw-body.ts';
import { routeAuth } from './plugins/route-auth.ts';
import { healthRoutes } from './routes/health.ts';
import { createWebhookRoutes, type EnqueueNangoWebhook } from './routes/webhooks.ts';

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
  /** Puts a stored Nango webhook delivery on its queue (BullMQ in main.ts). */
  enqueueNangoWebhook: EnqueueNangoWebhook;
  /** Finishes a connect attempt found at Nango by its tag (connections.complete). */
  enqueueConnectAttempt: EnqueueConnectAttempt;
  /** Purges a disconnected connection (connections.disconnect). */
  enqueuePurgeConnection: EnqueuePurgeConnection;
  /** Nango with the api's key; tests pass a fake. */
  nango?: NangoClient;
  /** Puts a failing test job on its queue; only used outside production (decision #069). */
  enqueueMonitoringTest: EnqueueMonitoringTest;
  /** Sends unexpected (5xx) errors to monitoring; IDs only. */
  reportError: ReportError;
  /** Requests per IP per minute; lowered in tests. */
  rateLimitMax?: number;
  /** Sign-in and sign-up attempts per IP per window. */
  loginRateLimit?: { max: number; timeWindow: string };
  /** Where logs go; tests capture them. Defaults to stdout. */
  logStream?: { write: (line: string) => void };
  /** Routes inside the /webhooks scope; tests may pass their own instead. */
  webhooks?: (scope: FastifyInstance) => Promise<void>;
}

/** Builds the API without listening, so tests can use `app.inject()`. */
export async function buildApp({
  env,
  redis,
  databases,
  enqueueExecuteAction,
  enqueueNangoWebhook,
  enqueueConnectAttempt,
  enqueuePurgeConnection,
  nango = createNangoClient({ secretKey: env.NANGO_SECRET_KEY }),
  enqueueMonitoringTest,
  reportError,
  rateLimitMax = 300,
  loginRateLimit = { max: 10, timeWindow: '15 minutes' },
  webhooks,
  logStream,
}: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { ...loggerOptions(env), ...(logStream ? { stream: logStream } : {}) },
    genReqId: () => randomUUID(),
    bodyLimit: 1024 * 1024,
    // Which proxies may set X-Forwarded-For; decides the client IP for rate limiting.
    trustProxy: toTrustProxy(env.API_TRUST_PROXY),
  });

  // Must come first: routes registered below are checked by these hooks.
  await app.register(errorHandler, { reportError });
  await app.register(routeAuth);
  await app.register(jsonOnly);

  await app.register(helmet);
  await app.register(rateLimit, { redis, max: rateLimitMax });

  const auth = createAuth({ env, authDb: databases.auth, appDb: databases.app, log: app.log });
  const router = createRouter({
    appDb: databases.app,
    resolveSession: (headers) => resolveSession(auth, databases.auth, headers),
    enqueueExecuteAction,
    connections: {
      nango,
      webhookUrlOverride: env.NANGO_WEBHOOK_URL_OVERRIDE,
      enqueueConnectAttempt,
      enqueuePurgeConnection,
    },
    enqueueMonitoringTest: testErrorsEnabled(env.SENTRY_ENVIRONMENT)
      ? enqueueMonitoringTest
      : undefined,
  });

  await app.register(healthRoutes, { release: env.APP_RELEASE });
  await app.register(authRoutes, { auth, env, loginRateLimit });
  await app.register(orpcRoutes, { router, reportError });
  await registerWebhookRoutes(
    app,
    webhooks ?? createWebhookRoutes({ env, appDb: databases.app, enqueueNangoWebhook }),
  );

  return app;
}

/** Fastify takes a hop count as a function: trust the first n hops from our side. */
function toTrustProxy(value: ApiEnv['API_TRUST_PROXY']) {
  if (typeof value === 'number') return (_address: string, hop: number) => hop < value;
  return value;
}
