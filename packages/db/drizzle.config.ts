import { existsSync } from 'node:fs';
import { parseEnv } from '@effectief/shared';
import { defineConfig } from 'drizzle-kit';
import { databaseEnvSchema } from './src/env.ts';

const rootEnvFile = new URL('../../.env', import.meta.url);
if (existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);

const env = parseEnv(databaseEnvSchema, process.env);

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: { url: env.DATABASE_URL },
  strict: true,
  verbose: true,
});
