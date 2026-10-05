import { isNotFound } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { requireTestErrors } from './test-errors.ts';

describe('requireTestErrors', () => {
  it('answers not found in production', () => {
    let thrown: unknown;
    try {
      requireTestErrors('production');
    } catch (error) {
      thrown = error;
    }
    expect(isNotFound(thrown)).toBe(true);
  });

  it('lets the page load everywhere else', () => {
    for (const environment of ['development', 'ci', 'stack', 'staging'] as const) {
      expect(() => requireTestErrors(environment)).not.toThrow();
    }
  });
});
