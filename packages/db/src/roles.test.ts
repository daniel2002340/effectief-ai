import { parseEnv } from '@effectief/shared';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { authDatabaseEnvSchema, databaseEnvSchema } from './env.ts';

// RLS only binds roles that are neither superuser, BYPASSRLS nor table owner.
// If any of these fails, every isolation test in this repo proves nothing
// (decisions #026, #031).

const env = parseEnv(databaseEnvSchema.extend(authDatabaseEnvSchema.shape), process.env);
const connections = {
  app: new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 }),
  auth: new pg.Pool({ connectionString: env.DATABASE_AUTH_URL, max: 1 }),
};
afterAll(() => Promise.all(Object.values(connections).map((pool) => pool.end())));

describe.each(Object.entries(connections))('runtime role (%s)', (_name, pool) => {
  it('is not a superuser and cannot bypass RLS, also not through a role it is a member of', async () => {
    const { rows } = await pool.query(
      `select rolname from pg_roles
        where pg_has_role(current_user, oid, 'MEMBER') and (rolsuper or rolbypassrls)`,
    );
    expect(rows).toEqual([]);
  });

  it('owns no table, also not through a role it is a member of', async () => {
    const { rows } = await pool.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p')
          and pg_has_role(current_user, c.relowner, 'MEMBER')`,
    );
    expect(rows).toEqual([]);
  });

  it('cannot change roles or create tables', async () => {
    const { rows } = await pool.query(
      `select rolcreaterole, rolcreatedb, has_schema_privilege(current_user, 'public', 'CREATE') as can_create
         from pg_roles where rolname = current_user`,
    );
    expect(rows).toEqual([{ rolcreaterole: false, rolcreatedb: false, can_create: false }]);
  });
});

describe('tenant tables', () => {
  it('every table with a tenant_id has forced RLS and a policy', async () => {
    const { rows } = await connections.app.query<{ relname: string; ok: boolean }>(
      `select c.relname,
              c.relrowsecurity and c.relforcerowsecurity
                and exists (select from pg_policy p where p.polrelid = c.oid) as ok
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
        where n.nspname = 'public' and c.relkind in ('r', 'p')`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((row) => !row.ok).map((row) => row.relname)).toEqual([]);
  });
});

describe('app role on the auth tables', () => {
  it.each(['user', 'session', 'account', 'verification', 'invitation'])(
    'has no access to %s',
    async (table) => {
      await expect(connections.app.query(`select 1 from "${table}" limit 1`)).rejects.toThrow(
        /permission denied/,
      );
    },
  );

  it.each(['organization', 'member'])('cannot write to %s', async (table) => {
    await expect(connections.app.query(`delete from "${table}"`)).rejects.toThrow(
      /permission denied/,
    );
  });
});
