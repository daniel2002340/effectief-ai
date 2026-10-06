import { createAction } from 'nango';
import * as z from 'zod';

// Which Gmail account a connection reads (docs/integrations.md §2.4). The
// worker stores only a hash of the account ID and shows the address.

const ProfileSchema = z.object({
  emailAddress: z.string().min(3),
});

const OutputSchema = z.object({
  accountId: z
    .string()
    .describe('Stable account ID; for Gmail the address. Example: "info@bedrijf.nl"'),
  email: z.string().describe('The address of the mailbox. Example: "info@bedrijf.nl"'),
});

const action = createAction({
  description: 'The Gmail account of the connection: its address',
  version: '1.0.0',
  input: z.object({}),
  output: OutputSchema,
  scopes: ['https://www.googleapis.com/auth/gmail.readonly'],

  exec: async (nango): Promise<z.infer<typeof OutputSchema>> => {
    const response = await nango.get({
      // https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile
      endpoint: '/gmail/v1/users/me/profile',
      retries: 3,
    });
    const profile = ProfileSchema.parse(response.data);
    return { accountId: profile.emailAddress.toLowerCase(), email: profile.emailAddress };
  },
});

export default action;
