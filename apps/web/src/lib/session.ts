import { ORPCError } from '@orpc/client';
import type { QueryClient } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import { orpc } from './orpc.ts';

/**
 * For routes behind login: loads the session's tenant, or sends the user to
 * the login page. The API decides; the client never picks a tenant itself.
 */
export async function requireTenant(queryClient: QueryClient) {
  try {
    return await queryClient.ensureQueryData(orpc.tenant.current.queryOptions());
  } catch (error) {
    if (error instanceof ORPCError && error.status === 401) throw redirect({ to: '/inloggen' });
    throw error;
  }
}
