import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.ts';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseClient {
  /** Raw client. Only for infrastructure code; customer data goes through withTenant(). */
  db: Database;
  close: () => Promise<void>;
}

export function createDatabase(databaseUrl: string): DatabaseClient {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  return {
    db: drizzle({ client: pool, schema }),
    close: () => pool.end(),
  };
}
