import { EnvValidationError, parseEnv } from '@effectief/shared';
import { describe, expect, it } from 'vitest';
import { webEnvSchema } from './env.ts';

const valid = {
  VITE_API_BASE_PATH: '/api',
  VITE_SENTRY_DSN: 'disabled',
  VITE_SENTRY_ENVIRONMENT: 'staging',
  VITE_APP_RELEASE: '0d5d691',
};

describe('web env', () => {
  it('accepts a same-origin API path', () => {
    expect(parseEnv(webEnvSchema, valid)).toEqual(valid);
  });

  it.each([[undefined], [''], ['https://api.example.com'], ['/api/']])('rejects %j', (value) => {
    expect(() => parseEnv(webEnvSchema, { ...valid, VITE_API_BASE_PATH: value })).toThrow(
      EnvValidationError,
    );
  });

  it('requires the Sentry variables, with "disabled" as the explicit off switch', () => {
    const { VITE_SENTRY_DSN: _, ...withoutDsn } = valid;
    expect(() => parseEnv(webEnvSchema, withoutDsn)).toThrow(/VITE_SENTRY_DSN/);
    expect(
      parseEnv(webEnvSchema, { ...valid, VITE_SENTRY_DSN: 'https://k@o1.ingest.de.sentry.io/3' })
        .VITE_SENTRY_DSN,
    ).toBe('https://k@o1.ingest.de.sentry.io/3');
  });
});
