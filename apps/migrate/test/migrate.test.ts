import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expectedMigration, findRoleProblems, isSchemaCurrent } from '@effectief/db/deploy';
import { parseEnv } from '@effectief/shared';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { migrateEnvSchema } from '../src/env.ts';
import { migrateAndPrepareRoles } from '../src/migrate.ts';

const migrationsDir = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));
const env = parseEnv(migrateEnvSchema, {
  ...process.env,
  LOG_LEVEL: 'silent',
  MIGRATIONS_DIR: migrationsDir,
});
const log = pino({ level: 'silent' });

describe('migrate env', () => {
  const valid = {
    NODE_ENV: 'production',
    LOG_LEVEL: 'info',
    DATABASE_MIGRATION_URL: 'postgres://postgres:owner@db.internal:5432/app',
    DATABASE_URL: `postgres://effectief_app:${'a'.repeat(64)}@db.internal:5432/app`,
    DATABASE_AUTH_URL: `postgres://effectief_auth:${'b'.repeat(64)}@db.internal:5432/app`,
    MIGRATIONS_DIR: migrationsDir,
  };

  it('accepts a production configuration', () => {
    expect(parseEnv(migrateEnvSchema, valid).MIGRATIONS_DIR).toBe(migrationsDir);
  });

  it('refuses short runtime passwords in production', () => {
    expect(() =>
      parseEnv(migrateEnvSchema, {
        ...valid,
        DATABASE_URL: 'postgres://effectief_app:kort@db.internal:5432/app',
      }),
    ).toThrow(/DATABASE_URL/);
  });

  it('refuses a runtime URL that uses the owner or a shared login role', () => {
    expect(() =>
      parseEnv(migrateEnvSchema, {
        ...valid,
        DATABASE_URL: `postgres://postgres:${'a'.repeat(64)}@db.internal:5432/app`,
      }),
    ).toThrow(/DATABASE_URL/);
    expect(() =>
      parseEnv(migrateEnvSchema, {
        ...valid,
        DATABASE_AUTH_URL: valid.DATABASE_URL,
      }),
    ).toThrow(/DATABASE_AUTH_URL/);
  });

  it('refuses a missing or relative migrations folder', () => {
    expect(() => parseEnv(migrateEnvSchema, { ...valid, MIGRATIONS_DIR: 'migrations' })).toThrow(
      /MIGRATIONS_DIR/,
    );
    expect(() =>
      parseEnv(migrateEnvSchema, { ...valid, MIGRATIONS_DIR: '/does/not/exist' }),
    ).toThrow(/MIGRATIONS_DIR/);
  });
});

describe('migration step (database)', () => {
  const owner = new pg.Client({ connectionString: env.DATABASE_MIGRATION_URL });
  const badRole = `test_bad_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

  afterAll(async () => {
    await owner.query(`drop role if exists ${badRole}`);
    await owner.end();
  });

  it('is idempotent: running it twice leaves runtime roles that cannot bypass RLS', async () => {
    await migrateAndPrepareRoles(env, log);
    await migrateAndPrepareRoles(env, log);
    await owner.connect();
    const names = [env.DATABASE_URL, env.DATABASE_AUTH_URL].map((url) => new URL(url).username);
    expect(await findRoleProblems(owner, names)).toEqual([]);
  });

  it('finds a login role that could bypass RLS', async () => {
    await owner.query(`create role ${badRole} login bypassrls`);
    const problems = await findRoleProblems(owner, [badRole]);
    expect(problems).toEqual([`${badRole}: superuser or bypassrls via ${badRole}`]);
  });

  it('lets the app role check the schema version', async () => {
    expect(expectedMigration.tag).toMatch(/^\d{4}_/);
    expect(await isSchemaCurrent(env.DATABASE_URL)).toBe(true);
  });
});
