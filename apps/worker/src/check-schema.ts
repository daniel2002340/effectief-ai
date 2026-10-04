// Pre-deploy command (decision #058): refuses to start this build on a schema
// that lacks its newest migration, also when someone redeploys by hand
// without running the migration job first. Connects as the app role.
import { databaseEnvSchema } from '@effectief/db';
import { expectedMigration, isSchemaCurrent } from '@effectief/db/deploy';
import { parseEnv } from '@effectief/shared';
import { pino } from 'pino';

const env = parseEnv(databaseEnvSchema, process.env);
const log = pino();

if (await isSchemaCurrent(env.DATABASE_URL)) {
  log.info({ migration: expectedMigration.tag }, 'schema is current');
} else {
  log.fatal({ migration: expectedMigration.tag }, 'schema lacks this build’s newest migration');
  process.exit(1);
}
