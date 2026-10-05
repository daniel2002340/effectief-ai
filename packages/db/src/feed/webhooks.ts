import {
  type StoredNangoWebhook,
  storedNangoWebhookSchema,
  webhookErrorCodes,
  webhookSources,
} from '@effectief/shared';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../client.ts';
import { webhookDeliveries } from '../schema/index.ts';
import type { TenantTransaction } from '../with-tenant.ts';

// webhook_deliveries (#038, docs/data-model.md): stored first, processed in a
// job. Only the job changes a delivery's status.

export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;

const recordInputSchema = z
  .strictObject({
    /** The connection it is about; for a creation webhook its attempt instead. */
    connectionId: z.uuid().optional(),
    connectAttemptId: z.uuid().optional(),
    source: z.enum(webhookSources),
    deliveryId: z.string().regex(/^[\w:-]{1,200}$/),
    payload: storedNangoWebhookSchema,
  })
  .refine(
    (input) => (input.connectionId === undefined) !== (input.connectAttemptId === undefined),
    {
      message: 'Exactly one of connectionId and connectAttemptId',
    },
  );
export type RecordWebhookDeliveryInput = z.input<typeof recordInputSchema>;

/**
 * Stores a delivery for the tenant of the transaction. A repeated delivery
 * (same source and delivery ID) is a no-op and returns the stored row with
 * `created: false`.
 */
export async function recordWebhookDelivery(
  tx: TenantTransaction,
  input: RecordWebhookDeliveryInput,
): Promise<{ delivery: WebhookDelivery; created: boolean }> {
  const values = recordInputSchema.parse(input);
  const [created] = await tx
    .insert(webhookDeliveries)
    .values(values)
    .onConflictDoNothing({
      target: [webhookDeliveries.tenantId, webhookDeliveries.source, webhookDeliveries.deliveryId],
    })
    .returning();
  if (created) return { delivery: created, created: true };
  const [existing] = await tx
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.source, values.source),
        eq(webhookDeliveries.deliveryId, values.deliveryId),
      ),
    );
  if (!existing) throw new Error('Webhook delivery conflicted but is not visible');
  return { delivery: existing, created: false };
}

export async function getWebhookDelivery(tx: TenantTransaction, id: string) {
  const [row] = await tx
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, z.uuid().parse(id)));
  return row;
}

/** The stored payload, parsed again: the job never trusts jsonb as structure. */
export function nangoPayloadOf(delivery: WebhookDelivery): StoredNangoWebhook {
  return storedNangoWebhookSchema.parse(delivery.payload);
}

/** Done: in the same transaction as the delivery's effects. Counts the attempt. */
export async function markWebhookDeliveryProcessed(tx: TenantTransaction, id: string) {
  await tx
    .update(webhookDeliveries)
    .set({
      status: 'processed',
      processedAt: sql`now()`,
      lastErrorCode: null,
      attempts: sql`${webhookDeliveries.attempts} + 1`,
    })
    .where(eq(webhookDeliveries.id, id));
}

/**
 * Failed: stays `failed` with a code until a later attempt processes it. Not
 * in the transaction of the effects, which was rolled back.
 */
export async function markWebhookDeliveryFailed(
  tx: TenantTransaction,
  id: string,
  code: (typeof webhookErrorCodes)[number],
) {
  await tx
    .update(webhookDeliveries)
    .set({
      status: 'failed',
      lastErrorCode: z.enum(webhookErrorCodes).parse(code),
      attempts: sql`${webhookDeliveries.attempts} + 1`,
    })
    .where(and(eq(webhookDeliveries.id, id), sql`${webhookDeliveries.status} <> 'processed'`));
}

/**
 * The tenant and connection of a Nango connection, through the SECURITY
 * DEFINER function resolve_connection() (migration 0017). Outside withTenant():
 * the webhook does not know its tenant yet. Returns ids only; undefined when
 * the connection is not ours (another environment on the shared Nango
 * environment, the dashboard, or not created yet).
 */
export async function resolveConnection(
  db: Database,
  integrationId: string,
  nangoConnectionId: string,
): Promise<{ tenantId: string; connectionId: string } | undefined> {
  const { rows } = await db.execute<{ tenant_id: string; connection_id: string }>(
    sql`select tenant_id, connection_id from public.resolve_connection(${integrationId}, ${nangoConnectionId})`,
  );
  const [row] = rows;
  return row ? { tenantId: row.tenant_id, connectionId: row.connection_id } : undefined;
}
