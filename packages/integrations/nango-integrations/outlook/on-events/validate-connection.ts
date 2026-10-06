import { createHash } from 'node:crypto';
import { createOnEvent } from 'nango';
import * as z from 'zod';

// A reconnect must read the same mailbox (docs/integrations.md §2.4). The
// first connect locks the Graph user id in the connection's metadata, as a
// hash; a later reconnect with another account is refused. The worker checks
// the account again after every reconnect.

const UserSchema = z.object({
  id: z.string().min(1),
});

const Metadata = z.object({
  accountIdHash: z.string().optional(),
});

/** The same value the worker stores as external_account_id. */
const accountIdHash = (userId: string) =>
  createHash('sha256').update(`outlook:${userId.trim().toLowerCase()}`).digest('hex');

export default createOnEvent({
  description: 'Locks the connection to the Microsoft account it was first created with',
  event: 'validate-connection',
  metadata: Metadata,
  exec: async (nango) => {
    const response = await nango.get({
      // https://learn.microsoft.com/en-us/graph/api/user-get
      endpoint: '/v1.0/me',
      params: { $select: 'id' },
      retries: 3,
    });
    const hash = accountIdHash(UserSchema.parse(response.data).id);
    const metadata = Metadata.parse((await nango.getMetadata()) ?? {});
    if (!metadata.accountIdHash) {
      await nango.setMetadata({ accountIdHash: hash });
      return;
    }
    if (metadata.accountIdHash !== hash) {
      throw new nango.ActionError({
        type: 'account_mismatch',
        message: 'Reconnected with another Microsoft account than the one connected',
      });
    }
  },
});
