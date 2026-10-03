import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from './client.ts';

export type TenantTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

const tenantIdSchema = z.uuid();

/**
 * Runs `fn` in a transaction scoped to one tenant. RLS policies read the
 * tenant from `app.tenant_id`, which is set transaction-locally so it can
 * never leak to the next user of the pooled connection.
 *
 * `tenantId` must come from the authenticated session or a job payload,
 * never from request input.
 */
export async function withTenant<T>(
  db: Database,
  tenantId: string,
  fn: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  const id = tenantIdSchema.parse(tenantId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${id}, true)`);
    return fn(tx);
  });
}
