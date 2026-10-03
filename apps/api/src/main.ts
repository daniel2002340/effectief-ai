import { parseEnv } from '@effectief/shared';
import { Redis } from 'ioredis';
import { buildApp } from './app.ts';
import { apiEnvSchema } from './env.ts';

const env = parseEnv(apiEnvSchema, process.env);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
const app = await buildApp({ env, redis });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await redis.quit();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: env.API_HOST, port: env.API_PORT });
