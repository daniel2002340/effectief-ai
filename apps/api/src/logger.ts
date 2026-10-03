import { redactPaths } from '@effectief/shared';
import type { FastifyServerOptions } from 'fastify';
import type { ApiEnv } from './env.ts';

export function loggerOptions(
  env: Pick<ApiEnv, 'LOG_LEVEL'>,
): Exclude<NonNullable<FastifyServerOptions['logger']>, boolean> {
  return {
    level: env.LOG_LEVEL,
    redact: { paths: redactPaths, censor: '[redacted]' },
    serializers: {
      // Only the path: query strings can contain personal data.
      req: (req: { id: string; method: string; url: string }) => ({
        id: req.id,
        method: req.method,
        path: req.url.split('?')[0],
      }),
    },
  };
}
