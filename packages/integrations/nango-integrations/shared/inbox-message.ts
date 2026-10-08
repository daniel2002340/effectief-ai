import * as z from 'zod';

// The record of every `inbox-messages` sync, Gmail and Outlook alike
// (docs/integrations.md §3.1, decision #074). The app has the same model in
// packages/shared/src/domain/inbox-message.ts and compares the two through the
// JSON schema `nango compile` writes. Only extend it, never break it: staging
// and local share the deployed functions.

/** Labels a record may carry: fixed values, never names of the user's own labels or folders. */
export const inboxLabels = [
  'INBOX',
  'UNREAD',
  'IMPORTANT',
  'STARRED',
  'CATEGORY_PERSONAL',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
] as const;
export type InboxLabel = (typeof inboxLabels)[number];

export const BODY_TEXT_MAX = 32_000;

export const InboxMessage = z.strictObject({
  id: z.string().describe('Message id at the provider. Example: "19a0c4e2f1b3d5a7"'),
  threadId: z
    .string()
    .describe('Gmail threadId or Outlook conversationId. Example: "19a0c4e2f1b3d5a7"'),
  internetMessageId: z
    .string()
    .optional()
    .describe('The Message-ID header. Example: "<abc@mail.example>"'),
  receivedAt: z.string().describe('ISO 8601. Example: "2026-10-06T08:15:00.000Z"'),
  from: z
    .strictObject({
      address: z.string().describe('Example: "jan@bedrijf.nl"'),
      name: z.string().optional().describe('Display name. Example: "Jan de Vries"'),
    })
    .optional(),
  to: z.array(z.string()).describe('Addresses only, no names'),
  cc: z.array(z.string()).describe('Addresses only, no names'),
  subject: z.string().optional(),
  bodyText: z.string().max(BODY_TEXT_MAX).describe('Plain text; HTML converted, max 32000 chars'),
  labels: z.array(z.enum(inboxLabels)),
  attachments: z.array(
    z.strictObject({
      name: z.string(),
      mimeType: z.string().describe('Example: "application/pdf"'),
      size: z.number().int().min(0).describe('Bytes'),
      attachmentId: z
        .string()
        .describe(
          'Stable reference to fetch it later: the Gmail partId (Gmail attachment ids change per fetch) or the Outlook attachment id. Example: "1.2"',
        ),
    }),
  ),
  backfill: z.boolean().describe('True for mail from the first 14-day sync'),
});
export type InboxMessage = z.infer<typeof InboxMessage>;
