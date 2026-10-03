import { randomUUID } from 'node:crypto';
import { parseEnv } from '@effectief/shared';
import pg from 'pg';
import { expect } from 'vitest';
import { createDatabase } from './client.ts';
import { authDatabaseEnvSchema, databaseEnvSchema } from './env.ts';
import { tenantSettings } from './schema/index.ts';
import { withTenant } from './with-tenant.ts';

// Test fixtures. Tests run as the app role (DATABASE_URL), which roles.test.ts
// proves is bound by RLS. Tenants and users are created as the auth role,
// like Better Auth does.

export interface TestTenant {
  tenantId: string;
  /** An owner of the tenant (a row in member). */
  userId: string;
}

export function openTestDatabases() {
  const env = parseEnv(databaseEnvSchema.extend(authDatabaseEnvSchema.shape), process.env);
  const app = createDatabase(env.DATABASE_URL);
  const authPool = new pg.Pool({ connectionString: env.DATABASE_AUTH_URL, max: 2 });
  const created: TestTenant[] = [];

  async function createTenant(): Promise<TestTenant> {
    const tenantId = randomUUID();
    const userId = randomUUID();
    await authPool.query(`insert into "user" (id, name, email) values ($1, 'Test', $2)`, [
      userId,
      `test-${userId}@example.test`,
    ]);
    await authPool.query(
      `insert into organization (id, name, slug, created_at) values ($1, 'Test', $2, now())`,
      [tenantId, `test-${tenantId}`],
    );
    await authPool.query(
      `insert into member (organization_id, user_id, role, created_at) values ($1, $2, 'owner', now())`,
      [tenantId, userId],
    );
    await withTenant(app.db, tenantId, (tx) => tx.insert(tenantSettings).values({ tenantId }));
    const tenant = { tenantId, userId };
    created.push(tenant);
    return tenant;
  }

  /** Deleting the organization cascades to every tenant table. */
  async function close() {
    await authPool.query('delete from organization where id = any($1)', [
      created.map((t) => t.tenantId),
    ]);
    await authPool.query('delete from "user" where id = any($1)', [created.map((t) => t.userId)]);
    await authPool.end();
    await app.close();
  }

  return { app, authPool, createTenant, close };
}

/** Drizzle wraps driver errors; the cause carries the Postgres error. */
const pgError = (code: string, message?: RegExp) => ({
  cause: expect.objectContaining({
    code,
    ...(message ? { message: expect.stringMatching(message) } : {}),
  }),
});

export const rlsViolation = pgError('42501', /row-level security/);
export const permissionDenied = pgError('42501', /permission denied/);
export const foreignKeyViolation = pgError('23503');
export const checkViolation = pgError('23514');
