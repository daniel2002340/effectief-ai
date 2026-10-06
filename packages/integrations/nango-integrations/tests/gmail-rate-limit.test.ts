import { describe, expect, it } from 'vitest';
import { isRateLimited, patiently } from '../gmail/helpers/rate-limit.js';

// Gmail's quota is per minute; the sync waits instead of failing the run
// (dry runs on staging hit the limit of Nango's Google app).

const httpError = (status: number, reason?: string) =>
  Object.assign(new Error('http'), {
    response: { status, data: { error: { errors: reason ? [{ reason }] : [] } } },
  });

describe('isRateLimited', () => {
  it('is a 429, or a 403 with a rate-limit reason; not a 403 for missing access', () => {
    expect(isRateLimited(httpError(429))).toBe(true);
    expect(isRateLimited(httpError(403, 'rateLimitExceeded'))).toBe(true);
    expect(isRateLimited(httpError(403, 'userRateLimitExceeded'))).toBe(true);
    expect(isRateLimited(httpError(403, 'insufficientPermissions'))).toBe(false);
    expect(isRateLimited(httpError(404))).toBe(false);
    expect(isRateLimited(new Error('network'))).toBe(false);
  });
});

describe('patiently', () => {
  it('waits and tries again on a rate limit, then gives up after the last attempt', async () => {
    const waits: number[] = [];
    const options = {
      attempts: 3,
      waitMs: 60_000,
      wait: async (ms: number) => void waits.push(ms),
    };
    let calls = 0;
    expect(
      await patiently(async () => {
        calls += 1;
        if (calls < 3) throw httpError(403, 'rateLimitExceeded');
        return 'ok';
      }, options),
    ).toBe('ok');
    expect(waits).toEqual([60_000, 60_000]);

    await expect(
      patiently(async () => {
        throw httpError(429);
      }, options),
    ).rejects.toMatchObject({ response: { status: 429 } });
  });

  it('does not retry other errors', async () => {
    let calls = 0;
    await expect(
      patiently(
        async () => {
          calls += 1;
          throw httpError(404);
        },
        { attempts: 3, waitMs: 1, wait: async () => {} },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
