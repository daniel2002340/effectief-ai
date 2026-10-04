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
 * True when the database has applied the given migration (default: this
 * build's newest). A newer schema is fine: migrations stay compatible with
 * the previous release (decision #058), so a rollback of the code may run on
 * it. Reads as the app role, which may only SELECT the migration table (0015).
 */
export async function isSchemaCurrent(
  databaseUrl: string,
  migration: { createdAt: number } = expectedMigration,
): Promise<boolean> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rowCount } = await client.query(
      'select 1 from drizzle.__drizzle_migrations where created_at = $1',
      [migration.createdAt],
    );
    return rowCount === 1;
  } catch (error) {
    // Before the very first migration the drizzle schema does not exist yet.
    if (error instanceof Error && 'code' in error && error.code === '3F000') return false;
    throw error;
  } finally {
    await client.end();
  }
}

export interface WaitForSchemaOptions {
  timeoutMs: number;
  intervalMs: number;
  migration?: { createdAt: number };
  onWait?: () => void;
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
    if (await isSchemaCurrent(databaseUrl, migration)) return true;
    if (Date.now() + intervalMs > deadline) return false;
    onWait?.();
    await sleep(intervalMs);
  }
}
