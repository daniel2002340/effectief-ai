import { redactPaths, scrubLoggedError } from '@effectief/shared';
import { type Logger, pino, stdSerializers } from 'pino';
import type { WorkerEnv } from './env.ts';

export function createLogger(env: Pick<WorkerEnv, 'LOG_LEVEL'>): Logger {
  return pino({
    level: env.LOG_LEVEL,
    redact: { paths: redactPaths, censor: '[redacted]' },
    serializers: {
      // Messages and stacks can contain email addresses and names (decision #070).
      err: (error: Error) => scrubLoggedError(stdSerializers.err(error), error),
    },
  });
}
