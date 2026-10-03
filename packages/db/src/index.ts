// Query operators from the same drizzle-orm copy as the schema, so apps do
// not depend on drizzle-orm themselves (a second copy breaks the types).
export { and, asc, eq, sql } from 'drizzle-orm';
export { createDatabase, type Database, type DatabaseClient } from './client.ts';
export {
  authDatabaseEnvSchema,
  type DatabaseEnv,
  databaseEnvSchema,
  migrationEnvSchema,
} from './env.ts';
export * as schema from './schema/index.ts';
export { type TenantTransaction, withTenant } from './with-tenant.ts';
