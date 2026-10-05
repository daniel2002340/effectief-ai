import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ConnectionRef, NangoClient } from './client.ts';
import type { NangoProvider } from './constants.ts';

// Which mailbox a connection reads (docs/integrations.md §2.4): our Nango
// action `account-info` (nango-integrations/<provider>/actions/account-info.ts)
// returns the provider's account ID and the address. The account ID is
// stored only as a hash: `external_account_id` is not personal data.

const ACCOUNT_INFO_ACTION = 'account-info';

/** The output of account-info, the same for Gmail and Outlook. */
export const accountInfoSchema = z.object({
  /** Gmail: the address of the profile; Outlook: the Graph user id. */
  accountId: z.string().trim().min(1).max(320),
  email: z.string().trim().min(3).max(320),
});

export interface MailboxAccount {
  /** sha256 of provider and account ID; compared after every re-authorization. */
  externalAccountId: string;
  /** The address the user sees (personal data, `account_label`). */
  accountLabel: string;
}

export function externalAccountIdOf(provider: NangoProvider, accountId: string): string {
  return createHash('sha256').update(`${provider}:${accountId.trim().toLowerCase()}`).digest('hex');
}

/** Asks Nango which account the connection reads. Needs `actions:execute` (worker key). */
export async function fetchMailboxAccount(
  nango: NangoClient,
  provider: NangoProvider,
  ref: ConnectionRef,
): Promise<MailboxAccount> {
  const info = await nango.triggerAction(ref, ACCOUNT_INFO_ACTION, accountInfoSchema);
  return {
    externalAccountId: externalAccountIdOf(provider, info.accountId),
    accountLabel: info.email.toLowerCase(),
  };
}
