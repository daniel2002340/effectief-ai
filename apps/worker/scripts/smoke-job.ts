// CI smoke test: enqueues one example job and waits until a running worker
// (the built artifact) completes it. Exits non-zero on failure or timeout.
//
//   node --env-file-if-exists=../../.env scripts/smoke-job.ts
import { defaultJobOptions, parseEnv, queueNames } from '@effectief/shared';
import { Queue, QueueEvents } from 'bullmq';
import { z } from 'zod';

const TIMEOUT_MS = 20_000;
const SMOKE_TENANT = '00000000-0000-4000-8000-00000000500e';

const env = parseEnv(z.object({ REDIS_URL: z.url({ protocol: /^rediss?$/ }) }), process.env);
const connection = { url: env.REDIS_URL, maxRetriesPerRequest: null };

const queue = new Queue(queueNames.example, { connection, defaultJobOptions });
const events = new QueueEvents(queueNames.example, { connection });

let exitCode = 1;
try {
  await events.waitUntilReady();
  const job = await queue.add('smoke', { tenantId: SMOKE_TENANT, note: 'smoke test' });
  const result = await job.waitUntilFinished(events, TIMEOUT_MS);
  process.stdout.write(`smoke job ${job.id} completed: ${JSON.stringify(result)}\n`);
  exitCode = 0;
} catch (error) {
  process.stderr.write(`smoke job failed: ${String(error)}\n`);
} finally {
  await events.close();
  await queue.close();
}
process.exit(exitCode);
