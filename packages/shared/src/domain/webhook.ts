import { z } from 'zod';

// webhook_deliveries: a received webhook, stored before processing (#038).
// Transport, not domain. The payload is what Zod kept of the body after the
// signature check: IDs, codes and counts, never personal data or provider
// error texts (docs/integrations.md §4.1).

export const webhookSources = ['nango', 'mollie'] as const;
export type WebhookSource = (typeof webhookSources)[number];

export const webhookDeliveryStatuses = ['received', 'processed', 'failed'] as const;
export type WebhookDeliveryStatus = (typeof webhookDeliveryStatuses)[number];

/** Why processing a delivery failed; a code, never an error message. */
export const webhookErrorCodes = ['invalid_payload', 'unknown', 'nango_unavailable'] as const;
export type WebhookErrorCode = (typeof webhookErrorCodes)[number];

/** A Nango connection or integration ID: no spaces, no free text. */
const nangoId = z.string().regex(/^[\w.:@-]{1,200}$/);
const shortCode = z.string().regex(/^[\w.:-]{1,100}$/);

/**
 * Tags we set on a connect session (§2.1). Nango lowercases tag keys. Others
 * (such as `end_user_email`, which we never send) are dropped, not stored.
 * Values are checked loosely: connections made elsewhere on the shared
 * environment (dashboard, MCP) may carry other values, and must be ignored
 * after lookup rather than refused as an invalid body.
 */
const tagValue = z.string().max(255);
const nangoTagsSchema = z.object({
  organization_id: tagValue.optional(),
  end_user_id: tagValue.optional(),
  /** The secret nonce of a connect attempt; never stored (see storedNangoWebhookSchema). */
  connect_attempt: tagValue.optional(),
});

/** Stored tags: only the UUIDs our own connect sessions set. */
const storedNangoTagsSchema = z.object({
  organization_id: z.uuid().optional(),
  end_user_id: z.uuid().optional(),
});

/**
 * Only the error type, reduced to a code; the description can hold provider
 * text. Nango does not document the types as a closed list (§5.1).
 */
const nangoErrorSchema = z.object({
  type: z
    .string()
    .max(500)
    .transform((type) => type.replace(/[^\w.:-]/g, '_').slice(0, 100) || 'unknown'),
});

export const nangoAuthOperations = ['creation', 'override', 'refresh', 'deletion'] as const;
export type NangoAuthOperation = (typeof nangoAuthOperations)[number];

export const nangoAuthWebhookSchema = z.object({
  type: z.literal('auth'),
  operation: z.enum(nangoAuthOperations),
  connectionId: nangoId,
  providerConfigKey: nangoId,
  provider: nangoId,
  /** The Nango environment name; compared case-insensitively. */
  environment: shortCode,
  success: z.boolean(),
  tags: nangoTagsSchema.nullish(),
  error: nangoErrorSchema.nullish(),
});
export type NangoAuthWebhook = z.infer<typeof nangoAuthWebhookSchema>;

const count = z.int().min(0);

/** Sync webhooks carry no records and no environment, only counts. */
export const nangoSyncWebhookSchema = z.object({
  type: z.literal('sync'),
  connectionId: nangoId,
  providerConfigKey: nangoId,
  syncName: nangoId,
  model: nangoId,
  success: z.boolean(),
  modifiedAfter: z.iso.datetime({ offset: true }).nullish(),
  responseResults: z.object({ added: count, updated: count, deleted: count }).nullish(),
  error: nangoErrorSchema.nullish(),
});
export type NangoSyncWebhook = z.infer<typeof nangoSyncWebhookSchema>;

export const nangoWebhookSchema = z.discriminatedUnion('type', [
  nangoAuthWebhookSchema,
  nangoSyncWebhookSchema,
]);
export type NangoWebhook = z.infer<typeof nangoWebhookSchema>;

/** What is stored: the same, without the nonce (the delivery points to its attempt instead). */
export const storedNangoWebhookSchema = z.discriminatedUnion('type', [
  nangoAuthWebhookSchema.extend({ tags: storedNangoTagsSchema.nullish() }),
  nangoSyncWebhookSchema,
]);
export type StoredNangoWebhook = z.infer<typeof storedNangoWebhookSchema>;

/**
 * The types and operations we handle. Nango adds types over time (forwarded
 * provider webhooks, for one); those are acknowledged and ignored.
 */
export function isHandledNangoWebhook(body: unknown): boolean {
  const head = z.object({ type: z.string(), operation: z.string().optional() }).safeParse(body);
  if (!head.success) return false;
  if (head.data.type === 'sync') return true;
  return (
    head.data.type === 'auth' &&
    (nangoAuthOperations as readonly string[]).includes(head.data.operation ?? '')
  );
}
