import { redactPaths } from '@effectief/shared';
import { type Logger, pino } from 'pino';
import type { WorkerEnv } from './env.ts';

export function createLogger(env: Pick<WorkerEnv, 'LOG_LEVEL'>): Logger {
  return pino({
    level: env.LOG_LEVEL,
    redact: { paths: redactPaths, censor: '[redacted]' },
  });
}
