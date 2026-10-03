import { type UpsertInsightInput, upsertInsightInputSchema } from '@effectief/shared';
import { and, asc, eq, gt, isNull, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { single } from '../memory/source.ts';
import { insights } from '../schema/index.ts';
import type { TenantTransaction } from '../with-tenant.ts';

// Derived, recomputable insights (docs/data-model.md, insights). No status:
// recomputing replaces the row, and expired insights are no longer listed.

export type Insight = typeof insights.$inferSelect;

/** Recomputing is an upsert on (kind, entity); an insight without entity is company-wide. */
export async function upsertInsight(tx: TenantTransaction, input: UpsertInsightInput) {
  const parsed = upsertInsightInputSchema.parse(input);
  const values = {
    kind: parsed.kind,
    entityId: parsed.kind === 'payment_behaviour' ? parsed.entityId : null,
    payload: parsed.payload,
    computedAt: sql`now()`,
    expiresAt: parsed.expiresAt,
  };
  return single(
    await tx
      .insert(insights)
      .values(values)
      .onConflictDoUpdate({
        target: [insights.tenantId, insights.kind, insights.entityId],
        set: {
          payload: values.payload,
          computedAt: values.computedAt,
          expiresAt: values.expiresAt,
        },
      })
      .returning(),
  );
}

/**
 * Insights that have not expired: company-wide ones without `entityId`,
 * those about one customer with it.
 */
export function listInsights(tx: TenantTransaction, filter: { entityId?: string } = {}) {
  const entity: SQL =
    filter.entityId === undefined
      ? isNull(insights.entityId)
      : eq(insights.entityId, z.uuid().parse(filter.entityId));
  return tx
    .select()
    .from(insights)
    .where(and(entity, gt(insights.expiresAt, sql`now()`)))
    .orderBy(asc(insights.kind), asc(insights.id));
}
