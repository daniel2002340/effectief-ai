import { z } from 'zod';

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });

/**
 * Runtime connection: the app role. No BYPASSRLS, owns nothing, so every
 * tenant table's RLS policy applies (decision #026).
 */
export const databaseEnvSchema = z.object({
  DATABASE_URL: postgresUrl,
});
export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;

/** Owner connection, only for migrations and test fixtures. Never used at runtime. */
export const migrationEnvSchema = z.object({
  DATABASE_MIGRATION_URL: postgresUrl,
});

/** Connection for Better Auth only: the auth role, limited to the auth tables (decision #031). */
export const authDatabaseEnvSchema = z.object({
  DATABASE_AUTH_URL: postgresUrl,
});
