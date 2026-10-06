import {
  type Database,
  getWebhookDelivery,
  markWebhookDeliveryFailed,
  markWebhookDeliveryProcessed,
  nangoPayloadOf,
  type TenantTransaction,
  type WebhookDelivery,
  withTenant,
} from '@effectief/db';
import { nangoWebhookJobSchema, type StoredNangoWebhook } from '@effectief/shared';
import type { Logger } from 'pino';
import { ZodError } from 'zod';

/**
 * What a delivery does, per kind, inside the transaction that also marks it
 * processed (docs/integrations.md §4.1). Kinds without a handler are marked
 * processed without effect: auth handling comes with connecting (§10 step 2),
 * mail ingest with step 3.
 */
type NangoWebhookHandler = (
  tx: TenantTransaction,
  input: { delivery: WebhookDelivery; payload: StoredNangoWebhook; jobId: string },
) => Promise<void>;

export interface NangoWebhookHandlers {
  auth?: NangoWebhookHandler;
  sync?: NangoWebhookHandler;
}

export async function processNangoWebhookJob(
  data: unknown,
  job: { jobId: string },
  { db, log, handlers = {} }: { db: Database; log: Logger; handlers?: NangoWebhookHandlers },
): Promise<{ processed: boolean }> {
  const { tenantId, deliveryId } = nangoWebhookJobSchema.parse(data);
  const ids = { jobId: job.jobId, tenantId, deliveryId };
  try {
    return await withTenant(db, tenantId, async (tx) => {
      const delivery = await getWebhookDelivery(tx, deliveryId);
      if (!delivery) {
        // Removed by retention, or never ours: nothing to do.
        log.warn(ids, 'nango webhook delivery not found');
        return { processed: false };
      }
      if (delivery.status === 'processed') return { processed: false };
      const payload = nangoPayloadOf(delivery);
      const handler = handlers[payload.type];
      if (handler) {
        await handler(tx, { delivery, payload, jobId: job.jobId });
      } else {
        log.info({ ...ids, type: payload.type }, 'nango webhook: no handler yet');
      }
      await markWebhookDeliveryProcessed(tx, delivery.id);
      return { processed: true };
    });
  } catch (error) {
    // The effects rolled back; the failure stays visible on the delivery and
    // the job retries (a failure never disappears silently).
    await withTenant(db, tenantId, (tx) =>
      markWebhookDeliveryFailed(
        tx,
        deliveryId,
        error instanceof ZodError ? 'invalid_payload' : 'unknown',
      ),
    ).catch((markError: unknown) => {
      log.error({ ...ids, err: markError }, 'marking nango webhook delivery failed did not work');
    });
    throw error;
  }
}
