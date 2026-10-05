import { z } from 'zod';
import journal from '../../migrations/meta/_journal.json' with { type: 'json' };

// Compares a database restored to a point in time with its source (docs/
// deployment.md §7.3). The queries only read, run as a superuser (RLS would
// hide rows from any other role) and return only table names, counts, IDs and
// row hashes; the hashes are compared in memory and never printed. How the SQL
// reaches each database is up to the caller (`railway ssh` on staging, a pg
// client in tests), so no credentials leave the database host.

/** Runs one SQL statement that returns a single JSON value and returns that text. */
export type SqlRunner = (sql: string) => Promise<string>;

/** Columns that mark when a row was written; the first one a table has is used. */
const timeColumns = ['created_at', 'occurred_at'] as const;

const catalogSchema = z.object({
  migrations: z.array(z.object({ hash: z.string(), createdAt: z.coerce.number() })),
  tables: z.array(
    z.object({
      name: z.string(),
      columns: z.array(z.string()),
      rls: z.boolean(),
      forceRls: z.boolean(),
    }),
  ),
  loginRoles: z.array(
    z.object({ name: z.string(), superuser: z.boolean(), bypassRls: z.boolean() }),
  ),
});
export type Catalog = z.infer<typeof catalogSchema>;

const tableStatsSchema = z.object({
  total: z.coerce.number(),
  /** Rows written before the restore time; null if the table has no time column. */
  before: z.coerce.number().nullable(),
  rows: z.array(z.object({ id: z.string(), hash: z.string() })),
});
const snapshotSchema = z.record(z.string(), tableStatsSchema);
export type Snapshot = z.infer<typeof snapshotSchema>;

const catalogSql = `
select json_build_object(
  'migrations', coalesce((
    select json_agg(json_build_object('hash', hash, 'createdAt', created_at) order by created_at)
    from drizzle.__drizzle_migrations), '[]'::json),
  'tables', coalesce((
    select json_agg(json_build_object(
      'name', c.relname,
      'columns', (select json_agg(a.attname order by a.attnum) from pg_attribute a
                  where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
      'rls', c.relrowsecurity,
      'forceRls', c.relforcerowsecurity) order by c.relname)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')), '[]'::json),
  'loginRoles', coalesce((
    select json_agg(json_build_object('name', rolname, 'superuser', rolsuper, 'bypassRls', rolbypassrls)
      order by rolname)
    from pg_roles where rolcanlogin and rolname not like 'pg\\_%'), '[]'::json)
)`;

function parseCatalog(text: string): Catalog {
  return catalogSchema.parse(JSON.parse(text));
}

function parseSnapshot(text: string): Snapshot {
  return snapshotSchema.parse(JSON.parse(text));
}

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

const timeColumnOf = (columns: string[]) => timeColumns.find((c) => columns.includes(c));

/**
 * Counts per table, plus a hashed sample of rows. On the source (`sample` is
 * a number) it picks random rows written before `at` and not updated since,
 * so the restored copy must hold exactly the same row. On the restored
 * database (`sample` is a list of IDs per table) it hashes those rows.
 */
function snapshotSql(
  catalog: Catalog,
  at: Date,
  sample: number | Record<string, string[]>,
): string {
  const cutoff = `${literal(at.toISOString())}::timestamptz`;
  const parts = catalog.tables.map((table) => {
    const t = ident(table.name);
    const time = timeColumnOf(table.columns);
    const before = time ? `(select count(*) from ${t} where ${ident(time)} < ${cutoff})` : 'null';
    let rows = `'[]'::json`;
    if (table.columns.includes('id')) {
      const hashed = `select r.id::text as id, md5(row_to_json(r)::text) as hash from ${t} r`;
      let query: string | undefined;
      if (typeof sample === 'number' && time) {
        const unchanged = table.columns.includes('updated_at')
          ? ` and r.updated_at < ${cutoff}`
          : '';
        query = `${hashed} where r.${ident(time)} < ${cutoff}${unchanged} order by random() limit ${Math.trunc(sample)}`;
      } else if (typeof sample === 'object' && sample[table.name]?.length) {
        const ids = sample[table.name]?.map(literal).join(', ');
        query = `${hashed} where r.id::text in (${ids})`;
      }
      if (query) rows = `coalesce((select json_agg(s) from (${query}) s), '[]'::json)`;
    }
    return `${literal(table.name)}, json_build_object('total', (select count(*) from ${t}), 'before', ${before}, 'rows', ${rows})`;
  });
  return `select json_build_object(${parts.join(',\n  ')})`;
}

interface Check {
  name: string;
  ok: boolean;
  /** Only IDs, counts and names; never row contents. */
  detail: string;
}

export interface RestoreReport {
  ok: boolean;
  checks: Check[];
  tables: {
    name: string;
    source: number;
    restored: number;
    sourceBefore: number | null;
    restoredBefore: number | null;
  }[];
}

const tagOf = (createdAt: number) =>
  journal.entries.find((e) => e.when === createdAt)?.tag ?? `unknown (${createdAt})`;
const lastTag = (catalog: Catalog) => {
  const last = catalog.migrations.at(-1);
  return last ? tagOf(last.createdAt) : 'none';
};

/** The restore protects the tenants as the source does: forced RLS on every tenant table, no privileged login role. */
function securityChecks(restored: Catalog): Check[] {
  const tenantTables = restored.tables.filter((t) => t.columns.includes('tenant_id'));
  const unprotected = tenantTables.filter((t) => !t.rls || !t.forceRls).map((t) => t.name);
  const privileged = restored.loginRoles
    .filter((r) => r.name.startsWith('effectief_') && (r.superuser || r.bypassRls))
    .map((r) => r.name);
  const runtime = restored.loginRoles
    .filter((r) => r.name.startsWith('effectief_'))
    .map((r) => r.name);
  return [
    {
      name: 'rls',
      ok: tenantTables.length > 0 && unprotected.length === 0,
      detail: unprotected.length
        ? `RLS not forced on: ${unprotected.join(', ')}`
        : `forced on ${tenantTables.length} tenant tables`,
    },
    {
      name: 'login roles',
      ok: runtime.length > 0 && privileged.length === 0,
      detail: privileged.length
        ? `superuser or BYPASSRLS: ${privileged.join(', ')}`
        : `${runtime.join(', ') || 'none found'} without superuser or BYPASSRLS`,
    },
  ];
}

export function compareRestore(input: {
  source: { catalog: Catalog; snapshot: Snapshot };
  restored: { catalog: Catalog; snapshot: Snapshot };
}): RestoreReport {
  const { source, restored } = input;
  const checks: Check[] = [];

  // The restore may predate a later deploy, so the restored migrations must be
  // the first n of the source's, not necessarily all of them.
  const prefix = restored.catalog.migrations.every(
    (m, i) => source.catalog.migrations[i]?.hash === m.hash,
  );
  const missing = source.catalog.migrations.length - restored.catalog.migrations.length;
  checks.push({
    name: 'migrations',
    ok: prefix && restored.catalog.migrations.length > 0,
    detail: !prefix
      ? 'restored migrations differ from the source'
      : missing > 0
        ? `restored at ${lastTag(restored.catalog)}; source has ${missing} newer (deployed after the restore time?)`
        : `both at ${lastTag(restored.catalog)}`,
  });

  const restoredNames = new Set(restored.catalog.tables.map((t) => t.name));
  const absent = source.catalog.tables.filter((t) => !restoredNames.has(t.name)).map((t) => t.name);
  checks.push({
    name: 'tables',
    ok: absent.length === 0 || missing > 0,
    detail: absent.length
      ? `missing in restore: ${absent.join(', ')}`
      : `${restoredNames.size} tables`,
  });

  const tables: RestoreReport['tables'] = [];
  const short: string[] = [];
  const missingRows: string[] = [];
  const changedRows: string[] = [];
  let sampled = 0;
  for (const table of source.catalog.tables) {
    const s = source.snapshot[table.name];
    const r = restored.snapshot[table.name];
    if (!s || !r) continue;
    tables.push({
      name: table.name,
      source: s.total,
      restored: r.total,
      sourceBefore: s.before,
      restoredBefore: r.before,
    });
    // Rows from before the restore time that still exist in the source must
    // all be in the restore; it may hold more (rows deleted since).
    if (s.before !== null && r.before !== null && r.before < s.before) {
      short.push(`${table.name} (${r.before} < ${s.before})`);
    }
    const restoredRows = new Map(r.rows.map((row) => [row.id, row.hash]));
    for (const row of s.rows) {
      sampled += 1;
      const hash = restoredRows.get(row.id);
      if (hash === undefined) missingRows.push(`${table.name}/${row.id}`);
      // A newer source schema may have added columns, so hashes only match on the same schema.
      else if (missing === 0 && hash !== row.hash) changedRows.push(`${table.name}/${row.id}`);
    }
  }
  checks.push({
    name: 'row counts',
    ok: short.length === 0,
    detail: short.length
      ? `fewer rows from before the restore time: ${short.join(', ')}`
      : 'every table has at least the rows the source has from before the restore time',
  });
  checks.push({
    name: 'sample',
    ok: missingRows.length === 0 && changedRows.length === 0,
    detail: [
      `${sampled} rows sampled`,
      missingRows.length ? `missing: ${missingRows.join(', ')}` : '',
      changedRows.length ? `different: ${changedRows.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; '),
  });
  checks.push(...securityChecks(restored.catalog));

  return { ok: checks.every((c) => c.ok), checks, tables };
}

/** Collects both sides and compares them. */
export async function verifyRestore(options: {
  source: SqlRunner;
  restored: SqlRunner;
  at: Date;
  samplePerTable?: number;
}): Promise<RestoreReport> {
  const [sourceCatalog, restoredCatalog] = await Promise.all([
    options.source(catalogSql).then(parseCatalog),
    options.restored(catalogSql).then(parseCatalog),
  ]);
  const sourceSnapshot = parseSnapshot(
    await options.source(snapshotSql(sourceCatalog, options.at, options.samplePerTable ?? 5)),
  );
  const ids = Object.fromEntries(
    Object.entries(sourceSnapshot).map(([name, stats]) => [name, stats.rows.map((r) => r.id)]),
  );
  // Only tables the restore has; a missing one is reported by compareRestore.
  const restoredSnapshot = parseSnapshot(
    await options.restored(snapshotSql(restoredCatalog, options.at, ids)),
  );
  return compareRestore({
    source: { catalog: sourceCatalog, snapshot: sourceSnapshot },
    restored: { catalog: restoredCatalog, snapshot: restoredSnapshot },
  });
}
