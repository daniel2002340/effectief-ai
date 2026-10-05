import { type MonitoringEnv, type ReportError, sentryOptions } from '@effectief/shared';
import * as Sentry from '@sentry/node';

/** Starts Sentry (decision #055) and returns how the app reports unexpected errors. */
export function initMonitoring(env: MonitoringEnv): ReportError {
  if (env.SENTRY_DSN === 'disabled') return () => {};
  Sentry.init({
    ...sentryOptions(env, 'worker'),
    // ExtraErrorData puts an error's own properties (such as `context`) in the
    // event, where beforeSend censors sensitive keys (decision #070).
    integrations: (defaults) => [
      ...defaults.filter((integration) => integration.name !== 'Console'),
      Sentry.extraErrorDataIntegration({ depth: 3 }),
    ],
  });
  return (error, context) => Sentry.captureException(error, { tags: context });
}

export async function closeMonitoring(): Promise<void> {
  await Sentry.close(2000);
}
