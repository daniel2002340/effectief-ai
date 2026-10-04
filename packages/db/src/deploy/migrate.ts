import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/**
 * Applies pending migrations as the owner. Same journal and table
 * (`drizzle.__drizzle_migrations`) as `drizzle-kit migrate`, so both can be
 * used on the same database; already applied migrations are skipped.
 */
export async function runMigrations(ownerUrl: string, migrationsFolder: string): Promise<void> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await migrate(drizzle({ client }), { migrationsFolder });
  } finally {
    await client.end();
  }
}
