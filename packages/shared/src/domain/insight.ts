import { z } from 'zod';
import type { InsightKind } from './status.ts';

// Derived, recomputable insights (docs/data-model.md, insights). Computed
// deterministically from events or live provider data, so no confirmation;
// they expire instead. Payloads hold counts and amounts only, no free text.

const count = z.int().min(0);

export const insightPayloadSchemas = {
  /** Company-wide: quotes open longer than `olderThanDays`. */
  open_quotes: z.strictObject({
    count,
    olderThanDays: z.int().min(1),
    totalExclVatCents: z.int().min(0),
  }),
  /** Per customer: how late they pay on average. */
  payment_behaviour: z.strictObject({
    invoiceCount: count,
    averageDaysLate: z.number().min(0).max(3650),
  }),
} satisfies Record<InsightKind, z.ZodType>;

export type InsightPayload<K extends InsightKind = InsightKind> = z.infer<
  (typeof insightPayloadSchemas)[K]
>;

/** Insights about one customer need an entity; company-wide ones have none. */
export const insightPerEntity = {
  open_quotes: false,
  payment_behaviour: true,
} as const satisfies Record<InsightKind, boolean>;

const insightBase = { expiresAt: z.date() };

export const upsertInsightInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('open_quotes'),
    payload: insightPayloadSchemas.open_quotes,
    ...insightBase,
  }),
  z.strictObject({
    kind: z.literal('payment_behaviour'),
    entityId: z.uuid(),
    payload: insightPayloadSchemas.payment_behaviour,
    ...insightBase,
  }),
]);
export type UpsertInsightInput = z.input<typeof upsertInsightInputSchema>;
