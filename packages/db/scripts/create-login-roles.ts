// Creates the login roles from DATABASE_URL and DATABASE_AUTH_URL as members
// of the group roles from migration 0001, for local development and CI. On a
// host the migration job does the same (apps/migrate, decision #059).
//
//   pnpm db:migrate && pnpm db:roles
import { existsSync } from 'node:fs';
import { parseEnv } from '@effectief/shared';
import pg from 'pg';
import { z } from 'zod';
import { ensureLoginRoles } from '../src/deploy/login-roles.ts';
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

const client = new pg.Client({ connectionString: env.DATABASE_MIGRATION_URL });
await client.connect();
try {
  const names = await ensureLoginRoles(client, [
    { url: env.DATABASE_URL, group: 'app_runtime' },
    { url: env.DATABASE_AUTH_URL, group: 'auth_runtime' },
  ]);
  process.stdout.write(`login roles: ${names.join(', ')}\n`);
} finally {
  await client.end();
}
