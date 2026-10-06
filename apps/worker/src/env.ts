import { databaseEnvSchema } from '@effectief/db';
import { nangoEnvSchema, requireNangoEnvironment } from '@effectief/integrations/nango';
import { monitoringEnvSchema, requireMonitoring } from '@effectief/shared';
import { z } from 'zod';

export const workerEnvSchema = z
  .object({
    DATABASE_URL: databaseEnvSchema.shape.DATABASE_URL,
    NODE_ENV: z.enum(['development', 'test', 'production']),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    ...monitoringEnvSchema.shape,
    // The worker's own key (app-worker); webhooks are the api's (§7.1).
    ...nangoEnvSchema.pick({ NANGO_ENVIRONMENT: true, NANGO_SECRET_KEY: true }).shape,
  })
  .superRefine(requireMonitoring())
  .superRefine(requireNangoEnvironment());

export type WorkerEnv = z.infer<typeof workerEnvSchema>;
