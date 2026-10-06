import { randomUUID } from 'node:crypto';
import { createDatabase, sql } from '@effectief/db';
import { createNangoClient } from '@effectief/integrations/nango';
import { nangoTestEnv } from '@effectief/integrations/testing';
import { parseEnv } from '@effectief/shared';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, expect } from 'vitest';
import { type AppDependencies, buildApp } from '../src/app.ts';
import { type ApiEnv, apiEnvSchema } from '../src/env.ts';

export const testEnv = parseEnv(apiEnvSchema, {
  ...process.env,
  ...nangoTestEnv,
  LOG_LEVEL: 'silent',
});

const redis = new Redis(testEnv.REDIS_URL);
// Same roles as production: the app role and the auth role, never the owner.
export const appDatabase = createDatabase(testEnv.DATABASE_URL);
export const authDatabase = createDatabase(testEnv.DATABASE_AUTH_URL);
afterAll(() => Promise.all([redis.quit(), appDatabase.close(), authDatabase.close()]));

/** Errors the API reported to monitoring, newest last; tests read and clear it. */
export const reportedErrors: { error: unknown; context: Record<string, unknown> }[] = [];

/** Monitoring-test jobs the API enqueued, newest last. */
export const enqueuedMonitoringTests: { tenantId: string }[] = [];

/** Nango webhook jobs the API enqueued, newest last; tests read and clear it. */
export const enqueuedNangoWebhooks: { tenantId: string; deliveryId: string }[] = [];

/** Connect-attempt jobs the API enqueued, newest last. */
export const enqueuedConnectAttempts: {
  tenantId: string;
  attemptId: string;
  nangoConnectionId: string;
}[] = [];

/** Purge jobs the API enqueued, newest last. */
export const enqueuedPurges: { tenantId: string; connectionId: string }[] = [];

/** Execute jobs the API enqueued, newest last; tests read and clear it. */
export const enqueuedExecutions: { tenantId: string; actionId: string; approvedAt: Date }[] = [];

/** A Nango client that fails every call, as if Nango were down. */
const unreachableNango = createNangoClient({
  secretKey: 'test-key-not-a-real-one',
  fetch: async () => {
    throw new TypeError('no network in tests');
  },
});

export type TestAppOptions = Partial<Omit<AppDependencies, 'env'>> & {
  env?: Partial<ApiEnv>;
};

/** Builds an app with real Valkey and Postgres; extend lets a test add routes before ready(). */
export async function createTestApp(
  { env, ...options }: TestAppOptions = {},
  extend?: (app: FastifyInstance) => void | Promise<void>,
): Promise<FastifyInstance> {
  // Rate-limit counters are keyed by IP and shared via Valkey; start every app clean.
  const keys = await redis.keys('ratelimit:api:*');
  if (keys.length > 0) await redis.del(...keys);
  const app = await buildApp({
    env: { ...testEnv, ...env },
    redis,
    databases: { app: appDatabase.db, auth: authDatabase.db },
    enqueueExecuteAction: async (job) => {
      enqueuedExecutions.push(job);
    },
    enqueueNangoWebhook: async (job) => {
      enqueuedNangoWebhooks.push(job);
    },
    enqueueConnectAttempt: async (job) => {
      enqueuedConnectAttempts.push(job);
    },
    enqueuePurgeConnection: async (job) => {
      enqueuedPurges.push(job);
    },
    // Never the real Nango: a test that needs it passes its own fake.
    nango: unreachableNango,
    enqueueMonitoringTest: async (job) => {
      enqueuedMonitoringTests.push(job);
    },
    reportError: (error, context) => {
      reportedErrors.push({ error, context });
    },
    ...options,
  });
  if (extend) await extend(app);
  await app.ready();
  return app;
}

const json = { 'content-type': 'application/json', origin: testEnv.APP_ORIGIN };
const createdUsers: string[] = [];
const createdTenants: string[] = [];

/** Signs up a user, creates their company and returns the session cookie. */
export async function registerTenant(app: FastifyInstance, company: string) {
  const email = `test-${randomUUID()}@example.test`;
  const signUp = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: json,
    payload: { name: 'Test Gebruiker', email, password: 'een-lang-wachtwoord' },
  });
  expect(signUp.statusCode).toBe(200);
  const userId: string = signUp.json().user.id;
  createdUsers.push(userId);
  // Creating the organization makes it the session's active tenant.
  const cookie = sessionCookie(signUp.headers['set-cookie']);

  const created = await app.inject({
    method: 'POST',
    url: '/api/auth/organization/create',
    headers: { ...json, cookie },
    payload: { name: company, slug: `test-${randomUUID()}` },
  });
  expect(created.statusCode).toBe(200);
  const tenantId: string = created.json().id;
  createdTenants.push(tenantId);
  return { email, cookie, tenantId, userId };
}

export function sessionCookie(header: string | string[] | undefined): string {
  const cookies = Array.isArray(header) ? header : header ? [header] : [];
  const session = cookies.find((value) => value.includes('session_token='));
  return session?.split(';')[0] ?? '';
}

/** Deleting the organizations cascades to members, sessions and every tenant table. */
export async function removeRegisteredTenants() {
  if (createdTenants.length > 0) {
    await authDatabase.db.execute(
      sql`delete from organization where id in ${sql.raw(`('${createdTenants.join("','")}')`)}`,
    );
  }
  if (createdUsers.length > 0) {
    await authDatabase.db.execute(
      sql`delete from "user" where id in ${sql.raw(`('${createdUsers.join("','")}')`)}`,
    );
  }
}
