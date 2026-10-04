import type pg from 'pg';
import { z } from 'zod';

/** A login role for a runtime connection and the group role it gets its rights from. */
export interface LoginRole {
  /** Connection URL whose user name and password define the login role. */
  url: string;
  group: 'app_runtime' | 'auth_runtime';
}

const roleName = z.string().regex(/^[a-z_][a-z0-9_]*$/);

/**
 * Creates or updates the login roles of the runtime connections as members of
 * the group roles from migration 0001 (decisions #031, #059). Passwords come
 * from the connection URLs, so they live in the host's variables, never in git.
 * Running it again sets the current password, which is how rotation works.
 */
export async function ensureLoginRoles(
  owner: pg.ClientBase,
  logins: LoginRole[],
): Promise<string[]> {
  const names: string[] = [];
  for (const { url, group } of logins) {
    const parsed = new URL(url);
    const name = roleName.parse(decodeURIComponent(parsed.username));
    const password = decodeURIComponent(parsed.password);
    const role = owner.escapeIdentifier(name);
    const exists = await owner.query('select 1 from pg_roles where rolname = $1', [name]);
    await owner.query(
      `${exists.rowCount ? 'ALTER' : 'CREATE'} ROLE ${role} LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${owner.escapeLiteral(password)}`,
    );
    await owner.query(`GRANT ${owner.escapeIdentifier(group)} TO ${role}`);
    names.push(name);
  }
  return names;
}

/**
 * Why a login role would make RLS meaningless: superuser or BYPASSRLS (also
 * via a role it is a member of), or ownership of a table in `public`.
 * Empty when all is well. Same rules as roles.test.ts.
 */
export async function findRoleProblems(owner: pg.ClientBase, names: string[]): Promise<string[]> {
  const { rows } = await owner.query<{ role: string; problem: string }>(
    `select login.rolname as role, 'superuser or bypassrls via ' || r.rolname as problem
       from pg_roles login
       join pg_roles r on pg_has_role(login.oid, r.oid, 'MEMBER')
      where login.rolname = any($1) and (r.rolsuper or r.rolbypassrls)
     union all
     select login.rolname, 'owns table ' || c.relname
       from pg_roles login
       join pg_class c on pg_has_role(login.oid, c.relowner, 'MEMBER')
       join pg_namespace n on n.oid = c.relnamespace
      where login.rolname = any($1) and n.nspname = 'public' and c.relkind in ('r', 'p')
     union all
     select login.rolname, 'can create roles or databases'
       from pg_roles login
      where login.rolname = any($1) and (login.rolcreaterole or login.rolcreatedb)`,
    [names],
  );
  return rows.map((row) => `${row.role}: ${row.problem}`);
}
