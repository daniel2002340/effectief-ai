import { type MonitoringEnv, type ReportError, sentryOptions } from '@effectief/shared';
import * as Sentry from '@sentry/node';

/** Starts Sentry (decision #055) and returns how the app reports unexpected errors. */
export function initMonitoring(env: MonitoringEnv): ReportError {
  if (env.SENTRY_DSN === 'disabled') return () => {};
  Sentry.init({
    ...sentryOptions(env, 'api'),
    integrations: (defaults) => defaults.filter((integration) => integration.name !== 'Console'),
  });
  return (error, context) => Sentry.captureException(error, { tags: context });
}

export async function closeMonitoring(): Promise<void> {
  await Sentry.close(2000);
}
