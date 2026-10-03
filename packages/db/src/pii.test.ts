import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { piiRegister } from './pii.ts';
import { openTestDatabases } from './test-support.ts';

// Every column of every tenant table needs a personal-data class
// (docs/data-model.md §3.7); a new column without one fails here.

const db = openTestDatabases();
afterAll(() => db.close());

describe('PII register', () => {
  it('classifies exactly the columns of every table with a tenant_id', async () => {
    const { rows } = await db.app.db.execute<{ table_name: string; column_name: string }>(sql`
      select c.relname as table_name, a.attname as column_name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
       where n.nspname = 'public' and c.relkind in ('r', 'p')
         and exists (select from pg_attribute t
                      where t.attrelid = c.oid and t.attname = 'tenant_id' and not t.attisdropped)
    `);
    const actual: Record<string, string[]> = {};
    for (const row of rows) {
      actual[row.table_name] = [...(actual[row.table_name] ?? []), row.column_name];
    }

    const sorted = (columns: Record<string, string[]>) =>
      Object.fromEntries(Object.entries(columns).map(([t, cols]) => [t, [...cols].sort()]));
    const registered = Object.fromEntries(
      Object.entries(piiRegister).map(([table, columns]) => [table, Object.keys(columns)]),
    );
    expect(sorted(actual)).toEqual(sorted(registered));
  });
});
