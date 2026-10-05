// Pre-deploy command of the verify job (decision #065), like check-schema in
// api and worker: waits as the app role until the schema has this build's
// newest migration, so the tests never run against an older schema.
// Fails after 15 minutes.
import { parseEnv } from '@effectief/shared';
import { expectedMigration, waitForSchema } from '../src/deploy/schema-version.ts';
import { databaseEnvSchema } from '../src/env.ts';

const env = parseEnv(databaseEnvSchema, process.env);
const log = (message: string) =>
  process.stdout.write(`${JSON.stringify({ migration: expectedMigration.tag, msg: message })}\n`);

const current = await waitForSchema(env.DATABASE_URL, {
  timeoutMs: 15 * 60_000,
  intervalMs: 5_000,
  onWait: (state) => log(`waiting for the migration job (${state})`),
});
if (!current) {
  log('schema still lacks this build’s newest migration');
  process.exit(1);
}
log('schema is current');
