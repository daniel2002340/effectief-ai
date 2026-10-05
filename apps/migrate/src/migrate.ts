import {
  ensureLoginRoles,
  expectedMigration,
  findRoleProblems,
  runMigrations,
} from '@effectief/db/deploy';
import pg from 'pg';
import type { Logger } from 'pino';
import type { MigrateEnv } from './env.ts';

/**
 * The deploy's migration step (decisions #058, #059): migrations as owner,
 * then the runtime login roles, then a check that none of them can bypass
 * RLS. Throws on any failure, so the deploy stops before api and worker.
 */
export async function migrateAndPrepareRoles(env: MigrateEnv, log: Logger): Promise<void> {
  await runMigrations(env.DATABASE_MIGRATION_URL, env.MIGRATIONS_DIR);
  log.info({ migration: expectedMigration.tag }, 'migrations applied');

  const owner = new pg.Client({ connectionString: env.DATABASE_MIGRATION_URL });
  await owner.connect();
  try {
    const roles = await ensureLoginRoles(owner, [
      { url: env.DATABASE_URL, group: 'app_runtime' },
      { url: env.DATABASE_AUTH_URL, group: 'auth_runtime' },
    ]);
    const problems = await findRoleProblems(owner, roles);
    if (problems.length > 0) {
      throw new Error(`Runtime roles could bypass row level security:\n${problems.join('\n')}`);
    }
    log.info({ roles }, 'login roles ready');
  } finally {
    await owner.end();
  }
}
