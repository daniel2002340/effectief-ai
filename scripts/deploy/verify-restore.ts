// Compares a Postgres service restored with PITR to its source (docs/
// deployment.md §7.3, docs/operations.md). Development tool, never in an image.
//
//   node scripts/deploy/verify-restore.ts --restored <service> --at <RFC3339> \
//     [--source postgres] [--sample 5]
//
// Each query runs inside the database container via `railway ssh`, as the
// container's own superuser, in a read-only transaction. No credentials and
// no database port leave Railway; the output holds only table names, counts
// and IDs. Exits 1 if a check fails.
import { execFile } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { type SqlRunner, verifyRestore } from '../../packages/db/src/deploy/verify-restore.ts';

const run = promisify(execFile);

const { values } = parseArgs({
  options: {
    source: { type: 'string', default: 'postgres' },
    restored: { type: 'string' },
    at: { type: 'string' },
    sample: { type: 'string', default: '5' },
  },
});
const at = new Date(values.at ?? '');
const sample = Number(values.sample);
if (!values.restored || Number.isNaN(at.getTime()) || !Number.isInteger(sample) || sample < 1) {
  process.stderr.write(
    'usage: node scripts/deploy/verify-restore.ts --restored <service> --at <RFC3339> [--source postgres] [--sample 5]\n',
  );
  process.exit(2);
}
if (values.restored === values.source) {
  process.stderr.write('--restored must be another service than --source\n');
  process.exit(2);
}

/** The SQL travels base64-encoded, so no quoting can break the remote shell command. */
const overSsh =
  (service: string): SqlRunner =>
  async (sql) => {
    const encoded = Buffer.from(sql).toString('base64');
    const remote = [
      `echo ${encoded} | base64 -d |`,
      `PGOPTIONS='-c default_transaction_read_only=on'`,
      `psql -X -q -At -v ON_ERROR_STOP=1 -h localhost -U "$PGUSER" -d "$PGDATABASE"`,
    ].join(' ');
    const { stdout } = await run('railway', ['ssh', '--service', service, '--', remote], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  };

const started = Date.now();
const report = await verifyRestore({
  source: overSsh(values.source),
  restored: overSsh(values.restored),
  at,
  samplePerTable: sample,
});

const lines = [
  `source ${values.source}, restored ${values.restored}, restore time ${at.toISOString()}`,
  '',
  ...report.checks.map((c) => `${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`),
  '',
  'table                     source  restored  before (source / restored)',
  ...report.tables.map(
    (t) =>
      `${t.name.padEnd(24)} ${String(t.source).padStart(7)} ${String(t.restored).padStart(9)}  ${t.sourceBefore ?? '-'} / ${t.restoredBefore ?? '-'}`,
  ),
  '',
  `${report.ok ? 'restore verified' : 'restore NOT verified'} in ${Math.round((Date.now() - started) / 1000)} s`,
];
process.stdout.write(`${lines.join('\n')}\n`);
process.exit(report.ok ? 0 : 1);
