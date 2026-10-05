import { createDatabase } from '@effectief/db';
import {
  defaultJobOptions,
  type ExecuteActionJob,
  executeActionJobId,
  type MonitoringTestJob,
  monitoringTestJobOptions,
  parseEnv,
  queueNames,
  testErrorsEnabled,
} from '@effectief/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { buildApp } from './app.ts';
import { apiEnvSchema } from './env.ts';
import { closeMonitoring, initMonitoring } from './monitoring.ts';

const env = parseEnv(apiEnvSchema, process.env);
const reportError = initMonitoring(env);
// Fail fast when Valkey is down: rate-limited requests are refused instead of
// hanging. The API still starts without Valkey, so /health keeps answering.
// family 0: resolve both IPv4 and IPv6, as private networks may offer either.
const redis = new Redis(env.REDIS_URL, { family: 0, maxRetriesPerRequest: 1, lazyConnect: true });
const appDatabase = createDatabase(env.DATABASE_URL);
const authDatabase = createDatabase(env.DATABASE_AUTH_URL);
const queueConnection = { url: env.REDIS_URL, family: 0, maxRetriesPerRequest: 1 };
const executeQueue = new Queue<ExecuteActionJob>(queueNames.executeAction, {
  connection: queueConnection,
  defaultJobOptions,
});
// Not in production: there the test procedure does not exist (decision #069).
const testQueue = testErrorsEnabled(env.SENTRY_ENVIRONMENT)
  ? new Queue<MonitoringTestJob>(queueNames.monitoringTest, {
      connection: queueConnection,
      defaultJobOptions: monitoringTestJobOptions,
    })
  : undefined;
const app = await buildApp({
  env,
  redis,
  databases: { app: appDatabase.db, auth: authDatabase.db },
  reportError,
  enqueueExecuteAction: async ({ tenantId, actionId, approvedAt }) => {
    await executeQueue.add(
      'execute',
      { tenantId, actionId },
      { jobId: executeActionJobId(actionId, approvedAt) },
    );
  },
  enqueueMonitoringTest: async (job) => {
    if (!testQueue) throw new Error('Test errors are disabled in production');
    await testQueue.add('fail', job);
  },
});
redis.on('error', (error) => app.log.error({ err: error }, 'valkey connection error'));
redis.connect().catch(() => {
  // Reported by the error listener above; ioredis keeps reconnecting.
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await Promise.all([
    redis.quit(),
    executeQueue.close(),
    testQueue?.close(),
    appDatabase.close(),
    authDatabase.close(),
    closeMonitoring(),
  ]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: env.API_HOST, port: env.API_PORT });
