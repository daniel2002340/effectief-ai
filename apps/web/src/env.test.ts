import { EnvValidationError, parseEnv } from '@effectief/shared';
import { describe, expect, it } from 'vitest';
import { webEnvSchema } from './env.ts';

describe('web env', () => {
  it('accepts a same-origin API path', () => {
    expect(parseEnv(webEnvSchema, { VITE_API_BASE_PATH: '/api' })).toEqual({
      VITE_API_BASE_PATH: '/api',
    });
  });

  it.each([[undefined], [''], ['https://api.example.com'], ['/api/']])('rejects %j', (value) => {
    expect(() => parseEnv(webEnvSchema, { VITE_API_BASE_PATH: value })).toThrow(EnvValidationError);
  });
});
