// Pre-deploy command of the `migrate` service (decision #058). A non-zero
// exit fails that deploy, and the deploy workflow stops before api and worker.
import { parseEnv } from '@effectief/shared';
import { migrateEnvSchema } from './env.ts';
import { createLogger } from './logger.ts';
import { migrateAndPrepareRoles } from './migrate.ts';

const env = parseEnv(migrateEnvSchema, process.env);
const log = createLogger(env);

try {
  await migrateAndPrepareRoles(env, log);
} catch (error) {
  log.fatal({ err: error }, 'migration step failed');
  process.exit(1);
}
