import { parseEnv } from '@effectief/shared';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll } from 'vitest';
import { type AppDependencies, buildApp } from '../src/app.ts';
import { apiEnvSchema } from '../src/env.ts';

export const testEnv = parseEnv(apiEnvSchema, { ...process.env, LOG_LEVEL: 'silent' });

const redis = new Redis(testEnv.REDIS_URL);
afterAll(() => redis.quit());

/** Builds an app with real Valkey; extend lets a test add routes before ready(). */
export async function createTestApp(
  options: Partial<Omit<AppDependencies, 'env' | 'redis'>> = {},
  extend?: (app: FastifyInstance) => void | Promise<void>,
): Promise<FastifyInstance> {
  // Rate-limit counters are keyed by IP and shared via Valkey; start every app clean.
  const keys = await redis.keys('ratelimit:api:*');
  if (keys.length > 0) await redis.del(...keys);
  const app = await buildApp({ env: testEnv, redis, ...options });
  if (extend) await extend(app);
  await app.ready();
  return app;
}
