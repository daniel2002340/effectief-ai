import { redactPaths, scrubLoggedError } from '@effectief/shared';
import type { FastifyServerOptions } from 'fastify';
import { stdSerializers } from 'pino';
import type { ApiEnv } from './env.ts';

/** Messages and stacks can contain email addresses and names (decision #070). */
export const errorSerializer = (error: Error) => scrubLoggedError(stdSerializers.err(error), error);

export function loggerOptions(
  env: Pick<ApiEnv, 'LOG_LEVEL'>,
): Exclude<NonNullable<FastifyServerOptions['logger']>, boolean> {
  return {
    level: env.LOG_LEVEL,
    redact: { paths: redactPaths, censor: '[redacted]' },
    serializers: {
      err: errorSerializer,
      // Only the path: query strings can contain personal data.
      req: (req: { id: string; method: string; url: string }) => ({
        id: req.id,
        method: req.method,
        path: req.url.split('?')[0],
      }),
    },
  };
}
