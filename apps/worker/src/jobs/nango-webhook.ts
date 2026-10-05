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
import { NangoApiError } from '@effectief/integrations/nango';
import { nangoWebhookJobSchema, type StoredNangoWebhook } from '@effectief/shared';
import type { Logger } from 'pino';
import { ZodError } from 'zod';
import type { Commit } from '../connections/connect.ts';

/**
 * What a delivery does, per kind (docs/integrations.md §4.1). A handler may
 * call Nango first, but makes its changes through `commit`, which runs them
 * in one transaction with marking the delivery processed. Kinds without a
 * handler are marked processed without effect (mail ingest comes in §10
 * step 3).
 */
type NangoWebhookHandler = (input: {
  tenantId: string;
  delivery: WebhookDelivery;
  payload: StoredNangoWebhook;
  jobId: string;
  commit: Commit;
}) => Promise<void>;

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
    const delivery = await withTenant(db, tenantId, (tx) => getWebhookDelivery(tx, deliveryId));
    if (!delivery) {
      // Removed by retention, or never ours: nothing to do.
      log.warn(ids, 'nango webhook delivery not found');
      return { processed: false };
    }
    if (delivery.status === 'processed') return { processed: false };
    const payload = nangoPayloadOf(delivery);

    let committed = false;
    const commit: Commit = (fn) =>
      withTenant(db, tenantId, async (tx: TenantTransaction) => {
        const result = await fn(tx);
        await markWebhookDeliveryProcessed(tx, delivery.id);
        committed = true;
        return result;
      });

    const handler = handlers[payload.type];
    if (handler) {
      await handler({ tenantId, delivery, payload, jobId: job.jobId, commit });
    } else {
      log.info({ ...ids, type: payload.type }, 'nango webhook: no handler yet');
    }
    if (!committed) await commit(async () => {});
    return { processed: true };
  } catch (error) {
    // The effects rolled back; the failure stays visible on the delivery and
    // the job retries (a failure never disappears silently).
    await withTenant(db, tenantId, (tx) =>
      markWebhookDeliveryFailed(
        tx,
        deliveryId,
        error instanceof ZodError
          ? 'invalid_payload'
          : error instanceof NangoApiError
            ? 'nango_unavailable'
            : 'unknown',
      ),
    ).catch((markError: unknown) => {
      log.error({ ...ids, err: markError }, 'marking nango webhook delivery failed did not work');
    });
    throw error;
  }
}
