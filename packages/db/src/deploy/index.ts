// Deploy steps (decisions #058, #059). Not part of the main entry: only the
// migration job and the pre-deploy checks of api and worker use them.
export { ensureLoginRoles, findRoleProblems, type LoginRole } from './login-roles.ts';
export { runMigrations } from './migrate.ts';
export { expectedMigration, isSchemaCurrent, waitForSchema } from './schema-version.ts';
