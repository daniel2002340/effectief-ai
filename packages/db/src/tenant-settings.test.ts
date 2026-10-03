import { randomUUID } from 'node:crypto';
import { parseEnv } from '@effectief/shared';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from './client.ts';
import { authDatabaseEnvSchema, databaseEnvSchema } from './env.ts';
import { organization, tenantSettings } from './schema/index.ts';
import { withTenant } from './with-tenant.ts';

// Runs as the app role (DATABASE_URL); roles.test.ts proves that role is
// bound by RLS. Fixtures are created as the auth role, like Better Auth does.

const env = parseEnv(databaseEnvSchema.extend(authDatabaseEnvSchema.shape), process.env);
const app = createDatabase(env.DATABASE_URL);
const authPool = new pg.Pool({ connectionString: env.DATABASE_AUTH_URL, max: 1 });

const A = randomUUID();
const B = randomUUID();
const C = randomUUID();

beforeAll(async () => {
  for (const id of [A, B, C]) {
    await authPool.query(
      `insert into organization (id, name, slug, created_at) values ($1, $2, $3, now())`,
      [id, `Bedrijf ${id}`, `test-${id}`],
    );
  }
  await withTenant(app.db, A, (tx) => tx.insert(tenantSettings).values({ tenantId: A }));
  await withTenant(app.db, B, (tx) =>
    tx.insert(tenantSettings).values({ tenantId: B, defaultVatRateBps: 900 }),
  );
});

afterAll(async () => {
  // Cascades to tenant_settings.
  await authPool.query('delete from organization where id = any($1)', [[A, B, C]]);
  await authPool.end();
  await app.close();
});

/** Drizzle wraps the driver error; the cause carries the Postgres message. */
const rlsViolation = { cause: { message: expect.stringMatching(/row-level security/) } };

const rowsOf = (result: { rows: unknown[] }) => result.rows as Record<string, unknown>[];

describe('tenant_settings isolation', () => {
  it('a tenant sees only its own row', async () => {
    const rows = await withTenant(app.db, A, (tx) => tx.select().from(tenantSettings));
    expect(rows.map((row) => row.tenantId)).toEqual([A]);
  });

  it('a tenant cannot read another tenant, also not with raw SQL', async () => {
    const viaOrm = await withTenant(app.db, A, (tx) =>
      tx.select().from(tenantSettings).where(eq(tenantSettings.tenantId, B)),
    );
    const viaSql = await withTenant(app.db, A, (tx) =>
      tx.execute(sql`select * from tenant_settings where tenant_id = ${B}`),
    );
    expect(viaOrm).toEqual([]);
    expect(viaSql.rows).toEqual([]);
  });

  it('a tenant cannot update or delete another tenant', async () => {
    const updated = await withTenant(app.db, A, (tx) =>
      tx.execute(sql`update tenant_settings set default_vat_rate_bps = 0 where tenant_id = ${B}`),
    );
    const deleted = await withTenant(app.db, A, (tx) =>
      tx.execute(sql`delete from tenant_settings where tenant_id = ${B}`),
    );
    expect(updated.rowCount).toBe(0);
    expect(deleted.rowCount).toBe(0);

    const [b] = await withTenant(app.db, B, (tx) => tx.select().from(tenantSettings));
    expect(b?.defaultVatRateBps).toBe(900);
  });

  it('a tenant cannot insert a row for another tenant', async () => {
    await expect(
      withTenant(app.db, A, (tx) => tx.insert(tenantSettings).values({ tenantId: C })),
    ).rejects.toMatchObject(rlsViolation);
  });

  it('a tenant cannot move its row to another tenant', async () => {
    await expect(
      withTenant(app.db, A, (tx) =>
        tx.execute(sql`update tenant_settings set tenant_id = ${C} where tenant_id = ${A}`),
      ),
    ).rejects.toMatchObject(rlsViolation);
  });

  it('without tenant context nothing is visible and nothing can be written', async () => {
    const rows = rowsOf(await app.db.execute(sql`select * from tenant_settings`));
    expect(rows).toEqual([]);
    await expect(
      app.db.execute(sql`insert into tenant_settings (tenant_id) values (${C})`),
    ).rejects.toMatchObject(rlsViolation);
  });
});

describe('organization and member for the app role', () => {
  it('only the current tenant organization is visible', async () => {
    const rows = await withTenant(app.db, A, (tx) => tx.select().from(organization));
    expect(rows.map((row) => row.id)).toEqual([A]);
  });

  it('no organization is visible without tenant context', async () => {
    expect(await app.db.select().from(organization)).toEqual([]);
  });
});
