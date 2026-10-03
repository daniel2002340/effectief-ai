import { createDatabase } from '@effectief/db';
import { parseEnv } from '@effectief/shared';
import { Redis } from 'ioredis';
import { buildApp } from './app.ts';
import { apiEnvSchema } from './env.ts';

const env = parseEnv(apiEnvSchema, process.env);
// Fail fast when Valkey is down: rate-limited requests are refused instead of
// hanging. The API still starts without Valkey, so /health keeps answering.
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
const appDatabase = createDatabase(env.DATABASE_URL);
const authDatabase = createDatabase(env.DATABASE_AUTH_URL);
const app = await buildApp({
  env,
  redis,
  databases: { app: appDatabase.db, auth: authDatabase.db },
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
  await Promise.all([redis.quit(), appDatabase.close(), authDatabase.close()]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: env.API_HOST, port: env.API_PORT });
