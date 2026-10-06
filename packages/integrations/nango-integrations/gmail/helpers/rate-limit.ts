// Gmail's per-user quota is counted per minute (docs: usage limits). On a
// rate limit Gmail answers 429, or 403 with reason rateLimitExceeded or
// userRateLimitExceeded; a quick retry only spends more quota. So: wait for
// the next minute and try again, a few times. Other 403s (no access) fail.

const RATE_LIMIT_REASONS = ['rateLimitExceeded', 'userRateLimitExceeded'];

export function isRateLimited(error: unknown): boolean {
  const response = (
    error as {
      response?: { status?: number; data?: { error?: { errors?: { reason?: string }[] } } };
    } | null
  )?.response;
  if (response?.status === 429) return true;
  if (response?.status !== 403) return false;
  return (response.data?.error?.errors ?? []).some(
    (item) => item.reason !== undefined && RATE_LIMIT_REASONS.includes(item.reason),
  );
}

export interface PatienceOptions {
  attempts: number;
  waitMs: number;
  wait: (ms: number) => Promise<void>;
  onWait?: (attempt: number) => Promise<void> | void;
}

/** Runs `call`; on a rate limit waits and tries again, up to `attempts` times in all. */
export async function patiently<T>(call: () => Promise<T>, options: PatienceOptions): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (!isRateLimited(error) || attempt >= options.attempts) throw error;
      await options.onWait?.(attempt);
      await options.wait(options.waitMs);
    }
  }
}
