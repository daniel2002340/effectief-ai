import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import journal from '../../migrations/meta/_journal.json' with { type: 'json' };

/** The newest migration this build knows about; bundled into api and worker at build time. */
export const expectedMigration = (() => {
  const last = journal.entries.at(-1);
  if (!last) throw new Error('Migration journal is empty');
  return { tag: last.tag, createdAt: last.when };
})();

/**
 * Why a runtime connection cannot start yet:
 * - `behind`: the newest migration of this build is not applied;
 * - `no-login`: the login role does not exist or has another password. On a
 *   first deploy the migration job creates it (#059), possibly after this
 *   check started; a wrong password looks the same, so callers log it.
 */
export type SchemaState = 'current' | 'behind' | 'no-login';

/** Postgres refuses the login: no such role (28000) or wrong password (28P01). */
const loginErrors = new Set(['28000', '28P01']);
const pgCode = (error: unknown) =>
  error instanceof Error && 'code' in error ? (error as { code: unknown }).code : undefined;

/**
 * Whether the database has applied the given migration (default: this
 * build's newest). A newer schema is fine: migrations stay compatible with
 * the previous release (decision #058), so a rollback of the code may run on
 * it. Reads as the app role, which may only SELECT the migration table (0015).
 */
export async function schemaState(
  databaseUrl: string,
  migration: { createdAt: number } = expectedMigration,
): Promise<SchemaState> {
  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
  } catch (error) {
    if (loginErrors.has(pgCode(error) as string)) return 'no-login';
    throw error;
  }
  try {
    const { rowCount } = await client.query(
      'select 1 from drizzle.__drizzle_migrations where created_at = $1',
      [migration.createdAt],
    );
    return rowCount === 1 ? 'current' : 'behind';
  } catch (error) {
    // Before the very first migration the drizzle schema does not exist yet.
    if (pgCode(error) === '3F000') return 'behind';
    throw error;
  } finally {
    await client.end();
  }
}

export interface WaitForSchemaOptions {
  timeoutMs: number;
  intervalMs: number;
  migration?: { createdAt: number };
  onWait?: (state: Exclude<SchemaState, 'current'>) => void;
}

/**
 * Waits until the schema has this build's newest migration. The pre-deploy
 * command of api and worker runs this, so a new version never starts before
 * the migration job finished, whatever order the host deploys in (#064).
 */
export async function waitForSchema(
  databaseUrl: string,
  { timeoutMs, intervalMs, migration = expectedMigration, onWait }: WaitForSchemaOptions,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await schemaState(databaseUrl, migration);
    if (state === 'current') return true;
    if (Date.now() + intervalMs > deadline) return false;
    onWait?.(state);
    await sleep(intervalMs);
  }
}
