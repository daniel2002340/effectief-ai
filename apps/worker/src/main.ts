import { createDatabase } from '@effectief/db';
import type { AdapterRegistry } from '@effectief/integrations';
import { parseEnv } from '@effectief/shared';
import { workerEnvSchema } from './env.ts';
import { createLogger } from './logger.ts';
import { startWorkers } from './worker.ts';

const env = parseEnv(workerEnvSchema, process.env);
const log = createLogger(env);

const database = createDatabase(env.DATABASE_URL);
// No provider adapters yet: an approved action fails as `unsupported`, with a
// card for the user, until its adapter exists (docs/todo.md).
const adapters: AdapterRegistry = {};

// BullMQ workers need maxRetriesPerRequest: null to block on Valkey.
const workers = startWorkers({
  connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
  log,
  db: database.db,
  adapters,
});
log.info({ queues: workers.map((worker) => worker.name) }, 'worker started');

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  // close() waits for running jobs to finish.
  await Promise.all(workers.map((worker) => worker.close()));
  await database.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
