import { z } from 'zod';

export const workerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;
