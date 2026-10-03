import { organizationClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { env } from './env.ts';

/** Better Auth's client; same origin, under the API path (decisions #021, #030). */
export const authClient = createAuthClient({
  baseURL: `${window.location.origin}${env.VITE_API_BASE_PATH}/auth`,
  plugins: [organizationClient()],
});

/** URL-safe slug for a new organization; the suffix keeps it unique. */
export function organizationSlug(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${base || 'bedrijf'}-${crypto.randomUUID().slice(0, 8)}`;
}
