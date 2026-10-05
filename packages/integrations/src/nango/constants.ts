import type { ConnectionProvider } from '@effectief/shared';

/** Nango Cloud; the same for every environment, which the API key selects. */
export const NANGO_API_URL = 'https://api.nango.dev';

/** The providers we connect through Nango, with their integration IDs (§7.5). */
export const nangoIntegrationIds = {
  gmail: 'gmail',
  outlook: 'outlook',
} as const satisfies Partial<Record<ConnectionProvider, string>>;

export type NangoProvider = keyof typeof nangoIntegrationIds;
export const nangoProviders = Object.keys(nangoIntegrationIds) as NangoProvider[];
