import { parseEnv } from '@effectief/shared';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll } from 'vitest';
import { type AppDependencies, buildApp } from '../src/app.ts';
import { type ApiEnv, apiEnvSchema } from '../src/env.ts';

const testEnv = parseEnv(apiEnvSchema, { ...process.env, LOG_LEVEL: 'silent' });

const redis = new Redis(testEnv.REDIS_URL);
afterAll(() => redis.quit());

export type TestAppOptions = Partial<Omit<AppDependencies, 'env'>> & {
  env?: Partial<ApiEnv>;
};

/** Builds an app with real Valkey; extend lets a test add routes before ready(). */
export async function createTestApp(
  { env, ...options }: TestAppOptions = {},
  extend?: (app: FastifyInstance) => void | Promise<void>,
): Promise<FastifyInstance> {
  // Rate-limit counters are keyed by IP and shared via Valkey; start every app clean.
  const keys = await redis.keys('ratelimit:api:*');
  if (keys.length > 0) await redis.del(...keys);
  const app = await buildApp({ env: { ...testEnv, ...env }, redis, ...options });
  if (extend) await extend(app);
  await app.ready();
  return app;
}
