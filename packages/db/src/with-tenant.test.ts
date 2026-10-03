import { parseEnv } from '@effectief/shared';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase } from './client.ts';
import { databaseEnvSchema } from './env.ts';
import { withTenant } from './with-tenant.ts';

const env = parseEnv(databaseEnvSchema, process.env);
const client = createDatabase(env.DATABASE_URL);

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';

async function currentTenant(run: (q: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }>) {
  const result = await run(sql`select current_setting('app.tenant_id', true) as tenant_id`);
  return (result.rows[0] as { tenant_id: string | null }).tenant_id;
}

afterAll(() => client.close());

describe('withTenant', () => {
  it('sets the tenant for the duration of the transaction', async () => {
    const seen = await withTenant(client.db, TENANT_A, (tx) => currentTenant((q) => tx.execute(q)));
    expect(seen).toBe(TENANT_A);
  });

  it('does not leak the tenant to the next query on the pool', async () => {
    await withTenant(client.db, TENANT_A, async () => {});
    const after = await currentTenant((q) => client.db.execute(q));
    expect(after === null || after === '').toBe(true);
  });

  it('keeps concurrent tenants apart', async () => {
    const [a, b] = await Promise.all([
      withTenant(client.db, TENANT_A, (tx) => currentTenant((q) => tx.execute(q))),
      withTenant(client.db, TENANT_B, (tx) => currentTenant((q) => tx.execute(q))),
    ]);
    expect([a, b]).toEqual([TENANT_A, TENANT_B]);
  });

  it('rejects a tenant id that is not a uuid', async () => {
    await expect(
      withTenant(client.db, "x'; drop table users; --", async () => {}),
    ).rejects.toThrow();
  });
});
