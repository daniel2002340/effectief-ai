import { sentryOptions } from '@effectief/shared';
import * as Sentry from '@sentry/react';
import { env } from './env.ts';

/** Browser errors to Sentry (decision #055). No tracing and no session replay. */
export function initMonitoring(): void {
  if (env.VITE_SENTRY_DSN === 'disabled') return;
  Sentry.init({
    ...sentryOptions(
      {
        SENTRY_DSN: env.VITE_SENTRY_DSN,
        SENTRY_ENVIRONMENT: env.VITE_SENTRY_ENVIRONMENT,
        APP_RELEASE: env.VITE_APP_RELEASE,
      },
      'web',
    ),
    integrations: (defaults) => defaults.filter((integration) => integration.name !== 'Console'),
  });
}
