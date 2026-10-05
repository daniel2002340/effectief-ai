import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { authDatabaseEnvSchema, databaseEnvSchema, migrationEnvSchema } from '@effectief/db';
import { z } from 'zod';

/**
 * The migration job is the only process with the owner's credentials
 * (decision #058). It also gets the runtime URLs, because it creates their
 * login roles (decision #059).
 */
export const migrateEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
    DATABASE_MIGRATION_URL: migrationEnvSchema.shape.DATABASE_MIGRATION_URL,
    DATABASE_URL: databaseEnvSchema.shape.DATABASE_URL,
    DATABASE_AUTH_URL: authDatabaseEnvSchema.shape.DATABASE_AUTH_URL,
    /** Absolute path to packages/db/migrations; set in the image. */
    MIGRATIONS_DIR: z
      .string()
      .refine((path) => isAbsolute(path) && existsSync(path), 'Must be an existing absolute path'),
  })
  .superRefine((env, ctx) => {
    const owner = new URL(env.DATABASE_MIGRATION_URL).username;
    for (const key of ['DATABASE_URL', 'DATABASE_AUTH_URL'] as const) {
      const url = new URL(env[key]);
      if (url.username === owner) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'Must not use the owner role' });
      }
      if (env.NODE_ENV === 'production' && decodeURIComponent(url.password).length < 32) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'Password must be at least 32 characters in production',
        });
      }
    }
    if (new URL(env.DATABASE_URL).username === new URL(env.DATABASE_AUTH_URL).username) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_AUTH_URL'],
        message: 'App and auth must use different login roles',
      });
    }
  });

export type MigrateEnv = z.infer<typeof migrateEnvSchema>;
