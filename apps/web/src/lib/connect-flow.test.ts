import type { CompleteConnectOutput, ConnectionSummary } from '@effectief/shared';
import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';
import {
  disconnectExplanation,
  lastSyncText,
  noticeForError,
  noticeForOutcome,
  notices,
  receivedMailText,
  statusText,
  waitForConnection,
} from './connect-flow.ts';

const pending: CompleteConnectOutput = { status: 'pending', failureCode: null, connectionId: null };

const connection = (overrides: Partial<ConnectionSummary> = {}): ConnectionSummary => ({
  id: '0199a1b2-0000-7000-8000-000000000001',
  provider: 'gmail',
  status: 'active',
  statusReason: null,
  accountLabel: 'info@bedrijf.example',
  lastSyncedAt: null,
  receivedMailCount: 0,
  connectedAt: new Date('2026-10-05T10:00:00Z'),
  canManage: true,
  ...overrides,
});

describe('waitForConnection', () => {
  it('asks until the flow is done', async () => {
    const answers: CompleteConnectOutput[] = [
      pending,
      pending,
      { status: 'connected', failureCode: null, connectionId: connection().id },
    ];
    let calls = 0;
    const outcome = await waitForConnection(async () => answers[calls++] ?? pending, {
      sleep: async () => {},
    });
    expect(outcome).toMatchObject({ status: 'connected' });
    expect(calls).toBe(3);
  });

  it('gives up after its attempts', async () => {
    expect(
      await waitForConnection(async () => pending, { attempts: 3, sleep: async () => {} }),
    ).toBe('timeout');
  });
});

describe('notices', () => {
  it('says plainly what happened', () => {
    expect(
      noticeForOutcome({ status: 'failed', failureCode: 'duplicate_account', connectionId: null }),
    ).toEqual(notices.duplicate);
    expect(
      noticeForOutcome({ status: 'failed', failureCode: 'expired', connectionId: null }),
    ).toEqual(notices.failed);
    expect(noticeForOutcome(pending)).toBeUndefined();
    expect(noticeForError(new ORPCError('SERVICE_UNAVAILABLE', { status: 503 }))).toEqual(
      notices.unavailable,
    );
    expect(noticeForError(new ORPCError('FORBIDDEN', { status: 403 }))).toEqual(notices.forbidden);
    expect(noticeForError(new Error('x'))).toEqual(notices.failed);
  });

  it('explains a status without jargon', () => {
    expect(statusText(connection())).toBe('Actief');
    expect(statusText(connection({ status: 'expired', statusReason: 'invalid_grant' }))).toMatch(
      /^Verlopen/,
    );
    expect(statusText(connection({ status: 'expired', statusReason: 'account_mismatch' }))).toMatch(
      /ander account/,
    );
  });

  it('shows "nog niet" until the first sync, then the time in Amsterdam', () => {
    expect(lastSyncText(null)).toBe('nog niet');
    expect(lastSyncText(new Date('2026-10-05T10:00:00Z'))).toContain('12:00');
  });

  it('counts the mails that came in', () => {
    expect(receivedMailText(0)).toBe('0 mails binnengekomen');
    expect(receivedMailText(1)).toBe('1 mail binnengekomen');
    expect(receivedMailText(1234)).toBe('1.234 mails binnengekomen');
  });

  it('tells Outlook users where to withdraw the access at Microsoft', () => {
    expect(disconnectExplanation('outlook')).toContain('myapps.microsoft.com');
    expect(disconnectExplanation('outlook')).toContain('account.live.com/consent/Manage');
    expect(disconnectExplanation('gmail')).toContain('myaccount.google.com/permissions');
  });
});
