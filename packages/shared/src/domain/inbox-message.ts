import { z } from 'zod';
import type { SyncModel } from './status.ts';

// A record of the Nango sync `inbox-messages` (docs/integrations.md §3.1,
// decision #074). The same model is defined in the Nango function
// (packages/integrations/nango-integrations/gmail/helpers/message.ts), which
// cannot import workspace packages; inbox-message.test.ts compares the two
// through the JSON schema `nango compile` writes. Only extend it, never break
// it: staging and local share the deployed function.
//
// Strict: a record with any other field (html, payload, contentBytes) is
// refused, so HTML and attachments never reach the app by accident.

export const inboxMessageLabels = [
  'INBOX',
  'UNREAD',
  'IMPORTANT',
  'STARRED',
  'CATEGORY_PERSONAL',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
] as const;
export type InboxMessageLabel = (typeof inboxMessageLabels)[number];

export const INBOX_MESSAGE_BODY_MAX = 32_000;

export const inboxMessageSchema = z.strictObject({
  id: z.string(),
  threadId: z.string(),
  internetMessageId: z.string().optional(),
  receivedAt: z.string(),
  from: z.strictObject({ address: z.string(), name: z.string().optional() }).optional(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string().optional(),
  bodyText: z.string().max(INBOX_MESSAGE_BODY_MAX),
  labels: z.array(z.enum(inboxMessageLabels)),
  attachments: z.array(
    z.strictObject({
      name: z.string(),
      mimeType: z.string(),
      size: z.int().min(0),
      attachmentId: z.string(),
    }),
  ),
  backfill: z.boolean(),
});
export type InboxMessage = z.infer<typeof inboxMessageSchema>;

/** The model name at Nango (GET /records?model=…). */
export const INBOX_MESSAGE_MODEL = 'InboxMessage' satisfies SyncModel;
