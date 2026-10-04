import { createDatabase } from '@effectief/db';
import type { AdapterRegistry } from '@effectief/integrations';
import { parseEnv } from '@effectief/shared';
import { workerEnvSchema } from './env.ts';
import { scheduleRetention } from './jobs/retention.ts';
import { createLogger } from './logger.ts';
import { closeMonitoring, initMonitoring } from './monitoring.ts';
import { startWorkers } from './worker.ts';

const env = parseEnv(workerEnvSchema, process.env);
const reportError = initMonitoring(env);
const log = createLogger(env);

const database = createDatabase(env.DATABASE_URL);
// No provider adapters yet: an approved action fails as `unsupported`, with a
// card for the user, until its adapter exists (docs/todo.md).
const adapters: AdapterRegistry = {};

// BullMQ workers need maxRetriesPerRequest: null to block on Valkey. family 0:
// resolve both IPv4 and IPv6, as private networks may offer either.
const started = startWorkers({
  connection: { url: env.REDIS_URL, family: 0, maxRetriesPerRequest: null },
  log,
  db: database.db,
  adapters,
  reportError,
});
await scheduleRetention(started.retentionQueue);
log.info({ queues: started.workers.map((worker) => worker.name) }, 'worker started');

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  await started.close();
  await database.close();
  await closeMonitoring();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
