import { createAction } from 'nango';
import * as z from 'zod';

// Which Microsoft account a connection reads (docs/integrations.md §2.4). The
// worker stores only a hash of the account ID and shows the address.

const UserSchema = z.object({
  id: z.string().min(1),
  mail: z.string().nullable().optional(),
  userPrincipalName: z.string().min(1),
});

const OutputSchema = z.object({
  accountId: z
    .string()
    .describe('The Graph user id. Example: "87d349ed-44d7-43e1-9a83-5f2406dee5bd"'),
  email: z.string().describe('The address of the mailbox. Example: "info@bedrijf.nl"'),
});

const action = createAction({
  description: 'The Microsoft account of the connection: its user id and address',
  version: '1.0.0',
  input: z.object({}),
  output: OutputSchema,
  scopes: ['User.Read'],

  exec: async (nango): Promise<z.infer<typeof OutputSchema>> => {
    const response = await nango.get({
      // https://learn.microsoft.com/en-us/graph/api/user-get
      endpoint: '/v1.0/me',
      params: { $select: 'id,mail,userPrincipalName' },
      retries: 3,
    });
    const user = UserSchema.parse(response.data);
    // Personal accounts can lack `mail`; the principal name is then the address.
    return { accountId: user.id, email: user.mail || user.userPrincipalName };
  },
});

export default action;
