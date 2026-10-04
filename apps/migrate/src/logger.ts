import { redactPaths } from '@effectief/shared';
import { type Logger, pino } from 'pino';
import type { MigrateEnv } from './env.ts';

export function createLogger(env: Pick<MigrateEnv, 'LOG_LEVEL'>): Logger {
  return pino({ level: env.LOG_LEVEL, redact: { paths: redactPaths, censor: '[redacted]' } });
}
