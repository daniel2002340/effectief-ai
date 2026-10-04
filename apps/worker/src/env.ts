import { databaseEnvSchema } from '@effectief/db';
import { monitoringEnvSchema } from '@effectief/shared';
import { z } from 'zod';

export const workerEnvSchema = z.object({
  DATABASE_URL: databaseEnvSchema.shape.DATABASE_URL,
  NODE_ENV: z.enum(['development', 'test', 'production']),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  ...monitoringEnvSchema.shape,
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;
