import { auditContextSchema, type RetentionStep, retentionSteps } from '@effectief/shared';
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../client.ts';
import { writeAudit } from '../feed/audit.ts';
import { actions, cards, eventContents, webhookDeliveries } from '../schema/index.ts';
import type { TenantTransaction } from '../with-tenant.ts';

// Retention (decision #037, docs/data-model.md event_contents). Source content
// goes after the tenant's period; the timeline keeps its summary, payload,
// external_id and links. Periods for action inputs and closed cards are the
// proposal of open question 3; the content period is per tenant and already
// stored as event_contents.retain_until.

export const retentionPeriods = {
  /** Inputs of an action this long after it was executed, rejected or failed. */
  actionInputDays: 180,
  /** Cards this long after they were closed. */
  closedCardMonths: 12,
  /** Processed webhook deliveries this long after processing (#038). */
  webhookDeliveryDays: 30,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const finishedActionStatuses = ['executed', 'rejected', 'failed'] as const;
const closedCardStatuses = ['done', 'dismissed', 'expired'] as const;

const auditObjectOf = {
  event_contents: 'event_contents',
  action_inputs: 'actions',
  closed_cards: 'cards',
  webhook_deliveries: 'webhook_deliveries',
} as const satisfies Record<RetentionStep, string>;

const batchInputSchema = z.strictObject({
  step: z.enum(retentionSteps),
  now: z.date(),
  limit: z.int().min(1).max(10_000).default(1_000),
  context: auditContextSchema.optional(),
});
export type RetentionBatchInput = z.input<typeof batchInputSchema>;

/** The cutoff of a step: rows older than this are expired. */
export function retentionCutoff(step: RetentionStep, now: Date): Date {
  if (step === 'event_contents') return now;
  if (step === 'action_inputs') {
    return new Date(now.getTime() - retentionPeriods.actionInputDays * DAY_MS);
  }
  if (step === 'webhook_deliveries') {
    return new Date(now.getTime() - retentionPeriods.webhookDeliveryDays * DAY_MS);
  }
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - retentionPeriods.closedCardMonths);
  return cutoff;
}

/**
 * Deletes or clears at most `limit` expired rows of one step, for the tenant
 * of the transaction, and writes one audit entry with the count (none when
 * nothing expired). Idempotent: a retry selects what is still left. The
 * caller repeats until fewer than `limit` rows came back.
 */
export async function purgeExpiredBatch(
  tx: TenantTransaction,
  input: RetentionBatchInput,
): Promise<number> {
  const { step, now, limit, context } = batchInputSchema.parse(input);
  const cutoff = retentionCutoff(step, now);
  const count = await purgeStep(tx, step, cutoff, limit);
  if (count > 0) {
    await writeAudit(tx, {
      actor: { type: 'system' },
      context,
      action: 'retention.purged',
      objectType: auditObjectOf[step],
      objectId: null,
      metadata: { step, count },
    });
  }
  return count;
}

async function purgeStep(
  tx: TenantTransaction,
  step: RetentionStep,
  cutoff: Date,
  limit: number,
): Promise<number> {
  switch (step) {
    case 'event_contents': {
      const expired = tx
        .select({ id: eventContents.eventId })
        .from(eventContents)
        .where(lt(eventContents.retainUntil, cutoff))
        .limit(limit);
      const rows = await tx
        .delete(eventContents)
        .where(inArray(eventContents.eventId, expired))
        .returning({ id: eventContents.eventId });
      return rows.length;
    }
    case 'action_inputs': {
      // updated_at moves with every status change, so it is the moment the
      // action reached its current status. actions_guard allows clearing both
      // inputs only together with input_purged_at.
      const expired = tx
        .select({ id: actions.id })
        .from(actions)
        .where(
          and(
            isNull(actions.inputPurgedAt),
            inArray(actions.status, [...finishedActionStatuses]),
            lt(actions.updatedAt, cutoff),
          ),
        )
        .limit(limit);
      const rows = await tx
        .update(actions)
        .set({ proposedInput: null, input: null, inputPurgedAt: sql`now()` })
        .where(inArray(actions.id, expired))
        .returning({ id: actions.id });
      return rows.length;
    }
    case 'closed_cards': {
      // Cascades to card_events, card_entities and the card's actions.
      const expired = tx
        .select({ id: cards.id })
        .from(cards)
        .where(and(inArray(cards.status, [...closedCardStatuses]), lt(cards.resolvedAt, cutoff)))
        .limit(limit);
      const rows = await tx
        .delete(cards)
        .where(inArray(cards.id, expired))
        .returning({ id: cards.id });
      return rows.length;
    }
    case 'webhook_deliveries': {
      // Only processed ones: a failed delivery stays until it is processed
      // after all or closed by hand (a failure never disappears silently).
      const expired = tx
        .select({ id: webhookDeliveries.id })
        .from(webhookDeliveries)
        .where(
          and(eq(webhookDeliveries.status, 'processed'), lt(webhookDeliveries.processedAt, cutoff)),
        )
        .limit(limit);
      const rows = await tx
        .delete(webhookDeliveries)
        .where(inArray(webhookDeliveries.id, expired))
        .returning({ id: webhookDeliveries.id });
      return rows.length;
    }
  }
}

/**
 * All tenant ids, through the SECURITY DEFINER function list_tenant_ids()
 * (migration 0014). The app role cannot read across tenants otherwise; this
 * returns ids only and is meant for jobs that fan out per tenant.
 */
export async function listTenantIds(db: Database): Promise<string[]> {
  const { rows } = await db.execute<{ id: string }>(
    sql`select id from public.list_tenant_ids() id`,
  );
  return rows.map((row) => row.id);
}
