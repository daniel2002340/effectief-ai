import type { FastifyServerOptions } from 'fastify';
import type { ApiEnv } from './env.ts';

/**
 * Personal data never reaches the logs: these paths are censored wherever
 * they appear one or two levels deep. Log IDs instead of content.
 */
export const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  ...[
    'email',
    'name',
    'firstName',
    'lastName',
    'phone',
    'address',
    'body',
    'text',
    'html',
    'subject',
    'password',
    'token',
    'secret',
  ].flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
];

export function loggerOptions(
  env: Pick<ApiEnv, 'LOG_LEVEL'>,
): NonNullable<FastifyServerOptions['logger']> {
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
