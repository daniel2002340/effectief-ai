import pg from 'pg';
import journal from '../../migrations/meta/_journal.json' with { type: 'json' };

/** The newest migration this build knows about; bundled into api and worker at build time. */
export const expectedMigration = (() => {
  const last = journal.entries.at(-1);
  if (!last) throw new Error('Migration journal is empty');
  return { tag: last.tag, createdAt: last.when };
})();

/**
 * True when the database has applied this build's newest migration. A newer
 * schema is fine: migrations stay compatible with the previous release
 * (decision #058), so a rollback of the code may run on it. Reads as the app
 * role, which may only SELECT the migration table (migration 0015).
 */
export async function isSchemaCurrent(databaseUrl: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rowCount } = await client.query(
      'select 1 from drizzle.__drizzle_migrations where created_at = $1',
      [expectedMigration.createdAt],
    );
    return rowCount === 1;
  } finally {
    await client.end();
  }
}
