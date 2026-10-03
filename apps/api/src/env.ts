import { databaseEnvSchema } from '@effectief/db';
import { z } from 'zod';

export const apiEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
  API_HOST: z.string().min(1),
  API_PORT: z.coerce.number().int().min(1).max(65535),
  DATABASE_URL: databaseEnvSchema.shape.DATABASE_URL,
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;
