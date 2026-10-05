import { type MonitoringEnvironment, testErrorsEnabled } from '@effectief/shared';
import { notFound } from '@tanstack/react-router';

/** The test error page does not exist in production (decision #069): it answers 404 there. */
export function requireTestErrors(environment: MonitoringEnvironment): void {
  if (!testErrorsEnabled(environment)) throw notFound();
}
