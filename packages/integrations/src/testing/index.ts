// Test doubles; never imported by production code.

export { nangoWebhookFixtures } from '../nango/fixtures.ts';
export { createFakeProvider, type FakeObject, type FakeProvider } from './fake-provider.ts';

/**
 * Nango settings for tests: never the developer's real keys from .env, and
 * the override `none`, so no test can reach Nango or point it elsewhere.
 */
export const nangoTestEnv = {
  NANGO_ENVIRONMENT: 'staging',
  NANGO_SECRET_KEY: '00000000-0000-0000-0000-000000000000',
  NANGO_WEBHOOK_SIGNING_KEY: 'test-signing-key-not-a-real-one',
  NANGO_WEBHOOK_URL_OVERRIDE: 'none',
} as const;
