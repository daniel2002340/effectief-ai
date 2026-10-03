// Creates the login roles from DATABASE_URL and DATABASE_AUTH_URL as members
// of the group roles from migration 0001. For local development and CI only:
// in production these roles and their passwords are managed outside the repo.
//
//   pnpm db:migrate && pnpm db:roles
import { existsSync } from 'node:fs';
import { parseEnv } from '@effectief/shared';
import pg from 'pg';
import { z } from 'zod';
import { authDatabaseEnvSchema, databaseEnvSchema, migrationEnvSchema } from '../src/env.ts';

const rootEnvFile = new URL('../../../.env', import.meta.url);
if (existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);

const env = parseEnv(
  migrationEnvSchema
    .extend(databaseEnvSchema.shape)
    .extend(authDatabaseEnvSchema.shape)
    .extend({ NODE_ENV: z.enum(['development', 'test']) }),
  process.env,
);

const roleName = z.string().regex(/^[a-z_][a-z0-9_]*$/);
const logins = [
  { url: new URL(env.DATABASE_URL), group: 'app_runtime' },
  { url: new URL(env.DATABASE_AUTH_URL), group: 'auth_runtime' },
];

const client = new pg.Client({ connectionString: env.DATABASE_MIGRATION_URL });
await client.connect();
try {
  for (const { url, group } of logins) {
    const name = roleName.parse(decodeURIComponent(url.username));
    const password = decodeURIComponent(url.password);
    const role = client.escapeIdentifier(name);
    const exists = await client.query('select 1 from pg_roles where rolname = $1', [name]);
    await client.query(
      `${exists.rowCount ? 'ALTER' : 'CREATE'} ROLE ${role} LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${client.escapeLiteral(password)}`,
    );
    await client.query(`GRANT ${client.escapeIdentifier(group)} TO ${role}`);
    process.stdout.write(`login role ${name} -> ${group}\n`);
  }
} finally {
  await client.end();
}
