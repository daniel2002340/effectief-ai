// Pre-deploy command (decisions #058, #064): waits until the schema has this
// build's newest migration, so the new version never starts before the
// migration job finished, also when the host deploys all services at once or
// someone redeploys by hand. Connects as the app role. Fails after 15 minutes.
import { databaseEnvSchema } from '@effectief/db';
import { expectedMigration, waitForSchema } from '@effectief/db/deploy';
import { parseEnv } from '@effectief/shared';
import { pino } from 'pino';

const env = parseEnv(databaseEnvSchema, process.env);
const log = pino().child({ migration: expectedMigration.tag });

const current = await waitForSchema(env.DATABASE_URL, {
  timeoutMs: 15 * 60_000,
  intervalMs: 5_000,
  onWait: (state) => log.info({ state }, 'waiting for the migration job'),
});
if (current) {
  log.info('schema is current');
} else {
  log.fatal('schema still lacks this build’s newest migration');
  process.exit(1);
}
