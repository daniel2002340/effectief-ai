import { z } from 'zod';
import { sensitiveKeys } from './logging.ts';

/** Every environment we run in; a typo is refused instead of counting as "not production". */
export const monitoringEnvironments = [
  'development',
  'test',
  'ci',
  'stack',
  'staging',
  'production',
] as const;
export type MonitoringEnvironment = (typeof monitoringEnvironments)[number];

/** Where monitoring must be on: `SENTRY_DSN=disabled` is refused there. */
const monitoredEnvironments: readonly MonitoringEnvironment[] = ['staging', 'production'];

/**
 * Refuses `disabled` as DSN on staging and production. Spreading `.shape`
 * into another schema drops refinements, so every env schema with these
 * variables adds this check itself; web passes its `VITE_*` names.
 */
export function requireMonitoring(
  keys: { dsn: string; environment: string } = {
    dsn: 'SENTRY_DSN',
    environment: 'SENTRY_ENVIRONMENT',
  },
) {
  return (env: Record<string, unknown>, ctx: z.RefinementCtx) => {
    const environment = env[keys.environment] as MonitoringEnvironment;
    if (env[keys.dsn] === 'disabled' && monitoredEnvironments.includes(environment)) {
      ctx.addIssue({
        code: 'custom',
        message: `Monitoring cannot be disabled in ${environment}`,
        path: [keys.dsn],
      });
    }
  };
}

/**
 * Error monitoring (decision #055). `SENTRY_DSN=disabled` turns it off
 * explicitly, and only outside staging and production; there is no default.
 * `APP_RELEASE` is the git SHA in images.
 */
export const monitoringEnvSchema = z
  .object({
    SENTRY_DSN: z.union([z.literal('disabled'), z.url({ protocol: /^https$/ })]),
    SENTRY_ENVIRONMENT: z.enum(monitoringEnvironments),
    APP_RELEASE: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  })
  .superRefine(requireMonitoring());
export type MonitoringEnv = z.infer<typeof monitoringEnvSchema>;

/**
 * The test errors (decision #069) exist everywhere except production. Decided
 * by the validated environment, never by a hostname.
 */
export function testErrorsEnabled(environment: MonitoringEnvironment): boolean {
  return environment !== 'production';
}

/** Fake personal data in the test errors; must never show up in Sentry or in the logs. */
export const monitoringTestData = {
  email: 'testfout.jansen@example.com',
  name: 'Testfout Jansen',
  token: 'testfout-token-not-a-secret',
} as const;

export type TestErrorService = 'api' | 'worker' | 'web';

/**
 * Thrown on purpose to check monitoring end to end: the fake email address
 * and name are in the message and, with a token, in `context`. Sentry and the
 * logs must show neither (decision #070).
 */
export class MonitoringTestError extends Error {
  readonly context: { service: TestErrorService; email: string; name: string; token: string };

  constructor(service: TestErrorService) {
    const { email, name, token } = monitoringTestData;
    super(`Testfout in ${service} voor ${name} <${email}>`);
    this.name = 'MonitoringTestError';
    this.context = { service, email, name, token };
  }
}

/** Postgres errors carry row values in these fields, e.g. `Key (email)=(…)`. */
const databaseErrorKeys = ['detail', 'where', 'parameters', 'query'];
const censoredKeys = new Set(
  [...sensitiveKeys, ...databaseErrorKeys, 'cookie', 'cookies', 'authorization'].map((key) =>
    key.toLowerCase(),
  ),
);
/** Request headers that may leave the process; everything else is dropped. */
const allowedHeaders = new Set(['content-type', 'user-agent', 'x-request-id']);
// No `/` on either side: stack frames such as `.pnpm/@orpc+server@1.15.4_…/x.mjs` are paths.
const emailPattern = /[^\s@<>()"',;:/]+@[^\s@<>()"',;:/]+\.[A-Za-z]{2,}/g;
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

/** Error properties that are not data; `name` is the error class, not a person. */
const errorOwnKeys = new Set(['name', 'message', 'stack']);

/**
 * Strings under sensitive keys in an error's own properties and in its
 * causes, such as `error.context.name`. Shorter strings are ignored: removing
 * them everywhere would mangle the text.
 */
function sensitiveValuesOf(error: unknown): string[] {
  const values = new Set<string>();
  const visit = (value: unknown, depth: number, sensitive: boolean) => {
    if (typeof value === 'string') {
      if (sensitive && value.length >= 3) values.add(value);
      return;
    }
    if (depth > 4 || value === null || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (value instanceof Error && errorOwnKeys.has(key)) continue;
      visit(item, depth + 1, sensitive || censoredKeys.has(key.toLowerCase()));
    }
    if (value instanceof Error && value.cause !== undefined) visit(value.cause, depth + 1, false);
  };
  visit(error, 0, false);
  // Longest first, so a name inside a longer value is not cut out of it first.
  return [...values].sort((a, b) => b.length - a.length);
}

/**
 * Removes personal data from an error's message or stack: email addresses,
 * and the values the error itself carries under sensitive keys. A name that
 * is only in the text, and nowhere in the error's data, cannot be recognised.
 * Used by `beforeSend` and by the loggers' `err` serializer.
 */
export function scrubErrorText(text: string, error: unknown): string {
  let scrubbed = scrubText(text);
  for (const value of sensitiveValuesOf(error)) scrubbed = scrubbed.split(value).join(censored);
  return scrubbed;
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
 * everywhere else. Messages also lose what the original error carries under
 * sensitive keys. Used as `beforeSend` in api, worker and web.
 */
export function scrubEvent<T extends ScrubbableEvent>(
  event: T,
  hint?: { originalException?: unknown },
): T {
  const error = hint?.originalException;
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
  if (event.message) event.message = scrubErrorText(event.message, error);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubErrorText(exception.value, error);
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

/**
 * For the loggers' `err` serializer: pino's serialized error with message
 * and stack scrubbed like in Sentry. Its other properties are censored by
 * the redact paths.
 */
export function scrubLoggedError<T extends { message: string; stack: string }>(
  serialized: T,
  error: unknown,
): T {
  return {
    ...serialized,
    message: scrubErrorText(serialized.message, error),
    stack: scrubErrorText(serialized.stack, error),
  };
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
