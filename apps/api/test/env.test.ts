import { EnvValidationError, parseEnv } from '@effectief/shared';
import { describe, expect, it } from 'vitest';
import { apiEnvSchema } from '../src/env.ts';

const validDatabases = {
  DATABASE_URL: 'postgres://app@localhost/db',
  DATABASE_AUTH_URL: 'postgres://auth@localhost/db',
  REDIS_URL: 'redis://localhost:6379',
};
const valid = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  API_HOST: '127.0.0.1',
  API_PORT: '3000',
  API_TRUST_PROXY: 'false',
  APP_ORIGIN: 'http://localhost:5180',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  ...validDatabases,
};

describe('api env', () => {
  it('refuses to start with missing variables', () => {
    expect(() => parseEnv(apiEnvSchema, {})).toThrow(EnvValidationError);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() =>
      parseEnv(apiEnvSchema, {
        ...valid,
        DATABASE_URL: 'mysql://localhost/db',
      }),
    ).toThrow(/DATABASE_URL/);
  });

  it('requires https for APP_ORIGIN in production', () => {
    const production = { ...valid, NODE_ENV: 'production' };
    expect(() =>
      parseEnv(apiEnvSchema, { ...production, APP_ORIGIN: 'http://app.example' }),
    ).toThrow(/APP_ORIGIN/);
    expect(
      parseEnv(apiEnvSchema, { ...production, APP_ORIGIN: 'https://app.example/' }).APP_ORIGIN,
    ).toBe('https://app.example');
  });

  it('refuses a short BETTER_AUTH_SECRET', () => {
    expect(() => parseEnv(apiEnvSchema, { ...valid, BETTER_AUTH_SECRET: 'kort' })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });
});
