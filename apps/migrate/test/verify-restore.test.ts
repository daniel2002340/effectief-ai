import { setTimeout as sleep } from 'node:timers/promises';
import { compareRestore, type SqlRunner, verifyRestore } from '@effectief/db/deploy';
import { openTestDatabases } from '@effectief/db/testing';
import { parseEnv } from '@effectief/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateEnvSchema } from '../src/env.ts';

// verify-restore compares a restored database with its source (docs/
// deployment.md §7.3). Here both sides are the local test database; the
// "restored" side runs inside a transaction that is rolled back, so a test can
// damage it without touching the source.

const env = parseEnv(migrateEnvSchema, {
  ...process.env,
  LOG_LEVEL: 'silent',
  MIGRATIONS_DIR: new URL('../../../packages/db/migrations', import.meta.url).pathname,
});

const runnerFor =
  (client: pg.Client): SqlRunner =>
  async (sql) => {
    const { rows } = await client.query<unknown[]>({ text: sql, rowMode: 'array' });
    return JSON.stringify(rows[0]?.[0]);
  };

describe('verify-restore (database)', () => {
  const databases = openTestDatabases();
  const source = new pg.Client({ connectionString: env.DATABASE_MIGRATION_URL });
  const restored = new pg.Client({ connectionString: env.DATABASE_MIGRATION_URL });
  let tenantId: string;
  let at: Date;

  beforeAll(async () => {
    await Promise.all([source.connect(), restored.connect()]);
    // The checks must work on a connection that cannot write.
    await source.query('set session characteristics as transaction read only');
    const tenant = await databases.createTenant();
    tenantId = tenant.tenantId;
    await databases.authPool.query(
      `update "user" set name = 'Testfout Jansen', email = 'testfout.jansen@example.com' where id = $1`,
      [tenant.userId],
    );
    await sleep(20);
    at = new Date();
  });

  afterAll(async () => {
    await Promise.all([source.end(), restored.end()]);
    await databases.close();
  });

  /**
   * Runs the check with `damage` applied to the restored side only. Both sides
   * share one exported snapshot: tests in other packages write to the same
   * database concurrently, and without it the source and restored queries see
   * different data.
   */
  async function verifyWith(damage?: (client: pg.Client) => Promise<unknown>) {
    await source.query('begin isolation level repeatable read');
    await restored.query('begin isolation level repeatable read');
    try {
      const { rows } = await source.query<{ id: string }>('select pg_export_snapshot() as id');
      await restored.query(`set transaction snapshot '${rows[0]?.id}'`);
      await damage?.(restored);
      return await verifyRestore({
        source: runnerFor(source),
        restored: runnerFor(restored),
        at,
        // Large enough that the test tenant is always in the sample.
        samplePerTable: 10_000,
      });
    } finally {
      await Promise.all([restored.query('rollback'), source.query('rollback')]);
    }
  }

  it('passes for an identical copy and prints no personal data', async () => {
    const report = await verifyWith();
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    const organization = report.tables.find((t) => t.name === 'organization');
    expect(organization?.restoredBefore).toBeGreaterThanOrEqual(1);
    const text = JSON.stringify(report);
    expect(text).not.toMatch(/jansen|example\.com/i);
    expect(text).not.toMatch(/[0-9a-f]{32}/); // no row hashes
  });

  it('finds rows from before the restore time that are missing', async () => {
    const report = await verifyWith((c) =>
      c.query('delete from organization where id = $1', [tenantId]),
    );
    expect(report.ok).toBe(false);
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    expect(byName['row counts']?.ok).toBe(false);
    expect(byName['row counts']?.detail).toContain('organization');
    expect(byName.sample?.detail).toContain(`organization/${tenantId}`);
  });

  it('finds a row whose contents differ', async () => {
    const report = await verifyWith((c) =>
      c.query(`update organization set name = 'Anders' where id = $1`, [tenantId]),
    );
    const sample = report.checks.find((c) => c.name === 'sample');
    expect(sample?.ok).toBe(false);
    expect(sample?.detail).toContain(`different: organization/${tenantId}`);
    expect(JSON.stringify(report)).not.toContain('Anders');
  });
});

describe('compareRestore', () => {
  const table = (name: string) => ({
    name,
    columns: ['id', 'tenant_id', 'created_at'],
    rls: true,
    forceRls: true,
  });
  const catalog = (hashes: string[]) => ({
    migrations: hashes.map((hash, i) => ({ hash, createdAt: i })),
    tables: [table('cards')],
    loginRoles: [{ name: 'effectief_app', superuser: false, bypassRls: false }],
  });
  const snapshot = { cards: { total: 3, before: 2, rows: [{ id: 'a', hash: 'h' }] } };

  it('accepts a restore from before a later migration, comparing rows by ID only', () => {
    const report = compareRestore({
      source: { catalog: catalog(['m1', 'm2']), snapshot },
      restored: {
        catalog: catalog(['m1']),
        snapshot: { cards: { total: 2, before: 2, rows: [{ id: 'a', hash: 'other' }] } },
      },
    });
    expect(report.ok).toBe(true);
    expect(report.checks[0]?.detail).toMatch(/source has 1 newer/);
  });

  it('refuses migrations that are not the same history', () => {
    const report = compareRestore({
      source: { catalog: catalog(['m1', 'm2']), snapshot },
      restored: { catalog: catalog(['x1']), snapshot },
    });
    expect(report.checks[0]).toMatchObject({ name: 'migrations', ok: false });
  });

  it('refuses a runtime login role that bypasses RLS', () => {
    const restoredCatalog = {
      ...catalog(['m1']),
      loginRoles: [{ name: 'effectief_app', superuser: false, bypassRls: true }],
    };
    const report = compareRestore({
      source: { catalog: catalog(['m1']), snapshot },
      restored: { catalog: restoredCatalog, snapshot },
    });
    expect(report.checks.find((c) => c.name === 'login roles')?.ok).toBe(false);
  });

  // ALTER TABLE in the rolled-back transaction would lock out the source side,
  // so this one compares catalogs directly.
  it('refuses a tenant table without forced RLS', () => {
    const restoredCatalog = {
      ...catalog(['m1']),
      tables: [{ ...table('cards'), forceRls: false }],
    };
    const report = compareRestore({
      source: { catalog: catalog(['m1']), snapshot },
      restored: { catalog: restoredCatalog, snapshot },
    });
    expect(report.checks.find((c) => c.name === 'rls')).toMatchObject({
      ok: false,
      detail: 'RLS not forced on: cards',
    });
  });
});
