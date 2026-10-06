import { createHash } from 'node:crypto';
import { createOnEvent } from 'nango';
import * as z from 'zod';

// A reconnect must read the same mailbox (docs/integrations.md §2.4). The
// first connect locks the account in the connection's metadata, as a hash
// (no address at Nango); a later reconnect with another account is refused.
// The worker checks the account again after every reconnect.

const ProfileSchema = z.object({
  emailAddress: z.string().min(3),
});

const Metadata = z.object({
  accountIdHash: z.string().optional(),
});

/** The same value the worker stores as external_account_id. */
const accountIdHash = (address: string) =>
  createHash('sha256').update(`gmail:${address.trim().toLowerCase()}`).digest('hex');

export default createOnEvent({
  description: 'Locks the connection to the Gmail account it was first created with',
  event: 'validate-connection',
  metadata: Metadata,
  exec: async (nango) => {
    const response = await nango.get({
      // https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile
      endpoint: '/gmail/v1/users/me/profile',
      retries: 3,
    });
    const hash = accountIdHash(ProfileSchema.parse(response.data).emailAddress);
    const metadata = Metadata.parse((await nango.getMetadata()) ?? {});
    if (!metadata.accountIdHash) {
      await nango.setMetadata({ accountIdHash: hash });
      return;
    }
    if (metadata.accountIdHash !== hash) {
      throw new nango.ActionError({
        type: 'account_mismatch',
        message: 'Reconnected with another Gmail account than the one connected',
      });
    }
  },
});
