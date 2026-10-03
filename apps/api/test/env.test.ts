import { EnvValidationError, parseEnv } from '@effectief/shared';
import { describe, expect, it } from 'vitest';
import { apiEnvSchema } from '../src/env.ts';

describe('api env', () => {
  it('refuses to start with missing variables', () => {
    expect(() => parseEnv(apiEnvSchema, {})).toThrow(EnvValidationError);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() =>
      parseEnv(apiEnvSchema, {
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        API_HOST: '127.0.0.1',
        API_PORT: '3000',
        API_TRUST_PROXY: 'false',
        DATABASE_URL: 'mysql://localhost/db',
        REDIS_URL: 'redis://localhost:6379',
      }),
    ).toThrow(/DATABASE_URL/);
  });
});
