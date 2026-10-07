import { createOnEvent } from 'nango';
import * as z from 'zod';

// Disconnecting withdraws the grant at Google too (docs/integrations.md §5.3,
// #077): the user no longer sees the app in their Google account. The token
// stays inside Nango; our own code never sees it. A failure is logged and
// never blocks the deletion: the connection must go either way.

const Credentials = z.object({
  access_token: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
});

// https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export default createOnEvent({
  description: 'Revokes the Google grant before the connection is deleted',
  event: 'pre-connection-deletion',
  exec: async (nango) => {
    try {
      const connection = await nango.getConnection();
      const credentials = Credentials.safeParse(connection.credentials);
      // Revoking the refresh token withdraws the whole grant; an access token
      // does too when it belongs to one.
      const token = credentials.success
        ? (credentials.data.refresh_token ?? credentials.data.access_token)
        : undefined;
      if (!token) {
        await nango.log('No Google token to revoke', { level: 'warn' });
        return;
      }
      const response = await nango.uncontrolledFetch({
        url: new URL(REVOKE_URL),
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
        redirect: 'error',
      });
      // 400 invalid_token: already revoked or expired, which is what we want.
      if (!response.ok && response.status !== 400) {
        await nango.log(`Revoking at Google failed with status ${response.status}`, {
          level: 'error',
        });
      }
    } catch (error) {
      // Never the token or the error body: only what kind of failure it was.
      await nango.log(
        `Revoking at Google failed: ${error instanceof Error ? error.name : 'unknown'}`,
        { level: 'error' },
      );
    }
  },
});
