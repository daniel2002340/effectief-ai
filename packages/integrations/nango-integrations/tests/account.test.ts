import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import gmailAccountInfo from '../gmail/actions/account-info.js';
import gmailValidate from '../gmail/on-events/validate-connection.js';
import outlookAccountInfo from '../outlook/actions/account-info.js';
import outlookValidate from '../outlook/on-events/validate-connection.js';

// Unit tests with a hand-made `nango` object. NOT dryrun mocks: there was no
// connection on staging yet to record them from (docs/todo.md). The response
// bodies follow the provider docs and are anonymized.

class ActionError extends Error {
  readonly payload: unknown;
  constructor(payload: unknown) {
    super('action error');
    this.payload = payload;
  }
}

function fakeNango(response: unknown, metadata: Record<string, unknown> | null = null) {
  const calls: { endpoint: string; params?: unknown }[] = [];
  const state = { metadata };
  const nango = {
    ActionError,
    get: async (config: { endpoint: string; params?: unknown }) => {
      calls.push({ endpoint: config.endpoint, params: config.params });
      return { data: response };
    },
    getMetadata: async () => state.metadata,
    setMetadata: async (value: Record<string, unknown>) => {
      state.metadata = value;
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: the Nango runtime type has far more than a test needs
  return { nango: nango as any, calls, state };
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

describe('gmail account-info', () => {
  it('returns the profile address as account id and address', async () => {
    const { nango, calls } = fakeNango({ emailAddress: 'Info@Bedrijf.example', messagesTotal: 10 });
    expect(await gmailAccountInfo.exec(nango, {})).toEqual({
      accountId: 'info@bedrijf.example',
      email: 'Info@Bedrijf.example',
    });
    expect(calls).toEqual([{ endpoint: '/gmail/v1/users/me/profile', params: undefined }]);
  });

  it('fails on an unexpected profile', async () => {
    const { nango } = fakeNango({});
    await expect(gmailAccountInfo.exec(nango, {})).rejects.toThrow();
  });
});

describe('outlook account-info', () => {
  it('returns the Graph user id and the mail address', async () => {
    const { nango, calls } = fakeNango({
      id: '00000000-0000-0000-0000-0000000000aa',
      mail: 'info@bedrijf.example',
      userPrincipalName: 'info_bedrijf.example#EXT#@tenant.example',
    });
    expect(await outlookAccountInfo.exec(nango, {})).toEqual({
      accountId: '00000000-0000-0000-0000-0000000000aa',
      email: 'info@bedrijf.example',
    });
    expect(calls).toEqual([
      { endpoint: '/v1.0/me', params: { $select: 'id,mail,userPrincipalName' } },
    ]);
  });

  it('falls back to the principal name for a personal account without mail', async () => {
    const { nango } = fakeNango({
      id: 'abc',
      mail: null,
      userPrincipalName: 'jan@outlook.example',
    });
    expect((await outlookAccountInfo.exec(nango, {})).email).toBe('jan@outlook.example');
  });
});

describe('validate-connection', () => {
  it('locks the first Gmail account as a hash, without the address', async () => {
    const { nango, state } = fakeNango({ emailAddress: 'Info@Bedrijf.example' });
    await gmailValidate.exec(nango);
    expect(state.metadata).toEqual({ accountIdHash: hash('gmail:info@bedrijf.example') });
    expect(JSON.stringify(state.metadata)).not.toContain('@');
  });

  it('accepts a reconnect with the same Gmail account and refuses another', async () => {
    const locked = { accountIdHash: hash('gmail:info@bedrijf.example') };
    await expect(
      gmailValidate.exec(fakeNango({ emailAddress: 'info@bedrijf.example' }, locked).nango),
    ).resolves.toBeUndefined();
    await expect(
      gmailValidate.exec(fakeNango({ emailAddress: 'ander@bedrijf.example' }, locked).nango),
    ).rejects.toMatchObject({ payload: { type: 'account_mismatch' } });
  });

  it('does the same for Outlook, on the Graph user id', async () => {
    const first = fakeNango({ id: 'User-1' });
    await outlookValidate.exec(first.nango);
    expect(first.state.metadata).toEqual({ accountIdHash: hash('outlook:user-1') });
    await expect(
      outlookValidate.exec(fakeNango({ id: 'user-2' }, first.state.metadata).nango),
    ).rejects.toMatchObject({ payload: { type: 'account_mismatch' } });
  });
});
