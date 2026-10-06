import { describe, expect, it } from 'vitest';
import preConnectionDeletion from '../gmail/on-events/pre-connection-deletion.js';

// A hand-made `nango` object: the function only reads the connection's
// credentials and calls Google's revoke endpoint. Tokens are fake.

interface Call {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
}

function fakeNango(credentials: unknown, respond: () => Promise<Response>) {
  const calls: Call[] = [];
  const logs: { message: string; level: unknown }[] = [];
  const nango = {
    getConnection: async () => ({ credentials }),
    uncontrolledFetch: async (options: Omit<Call, 'url'> & { url: URL }) => {
      calls.push({ ...options, url: options.url.toString() });
      return respond();
    },
    log: async (message: string, options?: { level?: string }) => {
      logs.push({ message, level: options?.level });
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: the Nango runtime type has far more than a test needs
  return { nango: nango as any, calls, logs };
}

const ok = async () => new Response(null, { status: 200 });

describe('gmail pre-connection-deletion', () => {
  it('revokes the refresh token at Google', async () => {
    const { nango, calls, logs } = fakeNango(
      { type: 'OAUTH2', access_token: 'fake-access', refresh_token: 'fake-refresh' },
      ok,
    );
    await preConnectionDeletion.exec(nango);
    expect(calls).toEqual([
      {
        url: 'https://oauth2.googleapis.com/revoke',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'token=fake-refresh',
        redirect: 'error',
      },
    ]);
    expect(logs).toEqual([]);
  });

  it('falls back to the access token without a refresh token', async () => {
    const { nango, calls } = fakeNango({ type: 'OAUTH2', access_token: 'fake-access' }, ok);
    await preConnectionDeletion.exec(nango);
    expect(calls[0]?.body).toBe('token=fake-access');
  });

  it('accepts an already revoked token (400) without an error log', async () => {
    const { nango, logs } = fakeNango(
      { refresh_token: 'fake-refresh' },
      async () => new Response('{"error":"invalid_token"}', { status: 400 }),
    );
    await preConnectionDeletion.exec(nango);
    expect(logs).toEqual([]);
  });

  it('logs without the token and never throws when Google fails or is unreachable', async () => {
    const failing = fakeNango(
      { refresh_token: 'fake-refresh' },
      async () => new Response('', { status: 503 }),
    );
    await expect(preConnectionDeletion.exec(failing.nango)).resolves.toBeUndefined();
    expect(failing.logs).toEqual([
      { message: 'Revoking at Google failed with status 503', level: 'error' },
    ]);

    const unreachable = fakeNango({ refresh_token: 'fake-refresh' }, async () => {
      throw new TypeError('fetch failed: fake-refresh');
    });
    await expect(preConnectionDeletion.exec(unreachable.nango)).resolves.toBeUndefined();
    expect(unreachable.logs).toEqual([
      { message: 'Revoking at Google failed: TypeError', level: 'error' },
    ]);
  });

  it('does nothing without credentials', async () => {
    const { nango, calls, logs } = fakeNango({ type: 'NONE' }, ok);
    await preConnectionDeletion.exec(nango);
    expect(calls).toEqual([]);
    expect(logs).toEqual([{ message: 'No Google token to revoke', level: 'warn' }]);
  });
});
