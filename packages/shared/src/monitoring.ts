import { z } from 'zod';
import { sensitiveKeys } from './logging.ts';

/**
 * Error monitoring (decision #055). `SENTRY_DSN=disabled` turns it off
 * explicitly; there is no default. `APP_RELEASE` is the git SHA in images.
 */
export const monitoringEnvSchema = z.object({
  SENTRY_DSN: z.union([z.literal('disabled'), z.url({ protocol: /^https$/ })]),
  SENTRY_ENVIRONMENT: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  APP_RELEASE: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
});
export type MonitoringEnv = z.infer<typeof monitoringEnvSchema>;

/** Postgres errors carry row values in these fields, e.g. `Key (email)=(…)`. */
const databaseErrorKeys = ['detail', 'where', 'parameters', 'query'];
const censoredKeys = new Set(
  [...sensitiveKeys, ...databaseErrorKeys, 'cookie', 'cookies', 'authorization'].map((key) =>
    key.toLowerCase(),
  ),
);
/** Request headers that may leave the process; everything else is dropped. */
const allowedHeaders = new Set(['content-type', 'user-agent', 'x-request-id']);
const emailPattern = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[A-Za-z]{2,}/g;
const censored = '[redacted]';

/** The parts of a Sentry event we touch. Structural, so this package needs no Sentry dependency. */
export interface ScrubbableEvent {
  message?: string | undefined;
  request?:
    | {
        url?: string | undefined;
        data?: unknown;
        cookies?: unknown;
        query_string?: unknown;
        headers?: Record<string, string> | undefined;
        env?: unknown;
      }
    | undefined;
  user?: { id?: string | number | undefined } | undefined;
  exception?: { values?: { value?: string | undefined }[] | undefined } | undefined;
  breadcrumbs?: ScrubbableBreadcrumb[] | undefined;
  extra?: Record<string, unknown> | undefined;
  contexts?: Record<string, unknown> | undefined;
  tags?: Record<string, unknown> | undefined;
}

export interface ScrubbableBreadcrumb {
  category?: string | undefined;
  message?: string | undefined;
  data?: Record<string, unknown> | undefined;
}

function scrubText(text: string): string {
  return text.replace(emailPattern, '[email]');
}

function withoutQuery(url: string): string {
  return url.split(/[?#]/)[0] ?? '';
}

/** Censors sensitive keys at any depth and email addresses in every string. */
function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      censoredKeys.has(key.toLowerCase()) ? censored : scrubValue(item, depth + 1),
    ]),
  );
}

/**
 * Removes personal data from an event before it leaves the process:
 * no request bodies, cookies, query strings or non-allowlisted headers,
 * a user reduced to its ID, and sensitive keys and email addresses censored
 * everywhere else. Used as `beforeSend` in api, worker and web.
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  if (event.request) {
    const { url, headers } = event.request;
    event.request = {
      ...(url ? { url: withoutQuery(url) } : {}),
      ...(headers
        ? {
            headers: Object.fromEntries(
              Object.entries(headers).filter(([name]) => allowedHeaders.has(name.toLowerCase())),
            ),
          }
        : {}),
    };
  }
  if (event.user) {
    event.user = event.user.id === undefined ? {} : { id: event.user.id };
  }
  if (event.message) event.message = scrubText(event.message);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubText(exception.value);
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.flatMap((crumb) => {
      const scrubbed = scrubBreadcrumb(crumb);
      return scrubbed ? [scrubbed] : [];
    });
  }
  if (event.extra) event.extra = scrubValue(event.extra) as Record<string, unknown>;
  if (event.contexts) event.contexts = scrubValue(event.contexts) as Record<string, unknown>;
  if (event.tags) event.tags = scrubValue(event.tags) as Record<string, unknown>;
  return event;
}

/** Drops console breadcrumbs and strips query strings and personal data from the rest. */
export function scrubBreadcrumb<T extends ScrubbableBreadcrumb>(crumb: T): T | null {
  if (crumb.category === 'console') return null;
  if (crumb.message) crumb.message = scrubText(crumb.message);
  if (crumb.data) {
    const data = { ...crumb.data };
    for (const key of ['url', 'from', 'to']) {
      const value = data[key];
      if (typeof value === 'string') data[key] = withoutQuery(value);
    }
    crumb.data = scrubValue(data) as Record<string, unknown>;
  }
  return crumb;
}

/** Reports an unexpected error with identifiers only; a no-op when monitoring is disabled. */
export type ReportError = (
  error: unknown,
  context: Record<string, string | number | undefined>,
) => void;

/**
 * SDK options shared by api, worker and web. Plain values only, so this
 * package does not depend on a Sentry SDK. Errors only: no tracing, no replay.
 */
export function sentryOptions(env: MonitoringEnv & { SENTRY_DSN: string }, service: string) {
  return {
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    release: env.APP_RELEASE,
    sendDefaultPii: false,
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
    initialScope: { tags: { service } },
  };
}
