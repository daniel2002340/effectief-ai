import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EnvValidationError, parseEnv } from './env.ts';

const schema = z.object({
  DATABASE_URL: z.url(),
  PORT: z.coerce.number().int(),
});

describe('parseEnv', () => {
  it('returns parsed values when everything is present', () => {
    expect(parseEnv(schema, { DATABASE_URL: 'postgres://db/app', PORT: '3000' })).toEqual({
      DATABASE_URL: 'postgres://db/app',
      PORT: 3000,
    });
  });

  it('throws and names every missing variable', () => {
    expect(() => parseEnv(schema, {})).toThrow(EnvValidationError);
    try {
      parseEnv(schema, {});
    } catch (error) {
      expect((error as EnvValidationError).variables).toEqual(['DATABASE_URL', 'PORT']);
    }
  });

  it('does not leak the invalid value in the message', () => {
    expect(() => parseEnv(schema, { DATABASE_URL: 'not-a-url-s3cr3t', PORT: '1' })).toThrow(
      /^(?![\s\S]*s3cr3t)/,
    );
  });
});
