import * as z from 'zod';
import { BODY_TEXT_MAX, type InboxLabel, InboxMessage } from '../../shared/inbox-message.js';
import { htmlToText, plainText } from '../../shared/text.js';

// Turns a Microsoft Graph message into an InboxMessage record
// (docs/integrations.md §3.1). Graph sends the body as text when asked
// (Prefer: outlook.body-content-type="text"); HTML never reaches this code.
// Attachments: metadata only, without contentBytes, and no inline images.

export { InboxMessage };

/** The message fields the sync asks for ($select); nothing else is read. */
export const MESSAGE_SELECT = [
  'id',
  'conversationId',
  'internetMessageId',
  'receivedDateTime',
  'from',
  'toRecipients',
  'ccRecipients',
  'subject',
  'body',
  'isRead',
  'isDraft',
  'hasAttachments',
].join(',');

/** The attachment fields the sync asks for: never contentBytes. */
export const ATTACHMENT_SELECT = 'id,name,contentType,size,isInline';

const Recipient = z.object({
  emailAddress: z
    .object({
      address: z.string().nullish(),
      name: z.string().nullish(),
    })
    .nullish(),
});

export const GraphMessage = z.object({
  id: z.string(),
  conversationId: z.string().nullish(),
  internetMessageId: z.string().nullish(),
  receivedDateTime: z.string(),
  from: Recipient.nullish(),
  toRecipients: z.array(Recipient).nullish(),
  ccRecipients: z.array(Recipient).nullish(),
  subject: z.string().nullish(),
  body: z.object({ contentType: z.string().nullish(), content: z.string().nullish() }).nullish(),
  isRead: z.boolean().nullish(),
  isDraft: z.boolean().nullish(),
  hasAttachments: z.boolean().nullish(),
});
export type GraphMessage = z.infer<typeof GraphMessage>;

const RemovedEntry = z.object({ id: z.string(), '@removed': z.object({ reason: z.string() }) });
const ChangedEntry = z.object({ id: z.string() });

/**
 * What an entry of a delta page means. Graph sends three shapes:
 * - `@removed`: the message left the folder (deleted, or moved, archived);
 * - a whole message (with `receivedDateTime`): new in the folder;
 * - only the id and what changed, such as `isRead`: a change to a message we
 *   already have (seen in a dry run, 2026-10-08; the docs name read state
 *   changes but not their shape). Nothing to take in: the app keeps mail it
 *   already has as it is (docs/integrations.md §4.4).
 */
export type DeltaEntry =
  | { kind: 'removed'; id: string }
  | { kind: 'message'; message: GraphMessage }
  | { kind: 'changed'; id: string };

export function deltaEntryOf(raw: unknown): DeltaEntry {
  const removed = RemovedEntry.safeParse(raw);
  if (removed.success) return { kind: 'removed', id: removed.data.id };
  if (raw && typeof raw === 'object' && 'receivedDateTime' in raw) {
    return { kind: 'message', message: GraphMessage.parse(raw) };
  }
  return { kind: 'changed', id: ChangedEntry.parse(raw).id };
}

export const DeltaPage = z.object({
  value: z.array(z.unknown()),
  '@odata.nextLink': z.string().optional(),
  '@odata.deltaLink': z.string().optional(),
});
export type DeltaPage = z.infer<typeof DeltaPage>;

export const GraphAttachment = z.object({
  id: z.string(),
  name: z.string().nullish(),
  contentType: z.string().nullish(),
  size: z.number().int().min(0).nullish(),
  isInline: z.boolean().nullish(),
});
export const AttachmentList = z.object({ value: z.array(GraphAttachment) });
export type GraphAttachment = z.infer<typeof GraphAttachment>;

const addressesOf = (recipients: z.infer<typeof Recipient>[] | null | undefined) =>
  (recipients ?? [])
    .map((recipient) => recipient.emailAddress?.address?.trim())
    .filter((address): address is string => Boolean(address));

/** Real attachments only: inline images are part of the HTML we never keep. */
export function attachmentsOf(attachments: GraphAttachment[]): InboxMessage['attachments'] {
  return attachments
    .filter((attachment) => !attachment.isInline)
    .map((attachment) => ({
      name: attachment.name?.trim() || 'bijlage',
      mimeType: attachment.contentType || 'application/octet-stream',
      size: attachment.size ?? 0,
      attachmentId: attachment.id,
    }));
}

/**
 * The body as text. Graph honours Prefer: outlook.body-content-type="text";
 * should it send HTML anyway, it is converted here, never kept.
 */
function bodyTextOf(message: GraphMessage): string {
  const content = message.body?.content ?? '';
  return message.body?.contentType?.toLowerCase() === 'html'
    ? htmlToText(content)
    : plainText(content);
}

export function toInboxMessage(
  message: GraphMessage,
  attachments: InboxMessage['attachments'],
  backfill: boolean,
): InboxMessage {
  const fromAddress = message.from?.emailAddress?.address?.trim();
  const fromName = message.from?.emailAddress?.name?.trim();
  const internetMessageId = message.internetMessageId?.trim();
  const subject = message.subject?.trim();
  const labels: InboxLabel[] = message.isRead === false ? ['INBOX', 'UNREAD'] : ['INBOX'];
  return {
    id: message.id,
    threadId: message.conversationId || message.id,
    ...(internetMessageId ? { internetMessageId } : {}),
    receivedAt: new Date(message.receivedDateTime).toISOString(),
    ...(fromAddress
      ? {
          from: {
            address: fromAddress,
            ...(fromName && fromName !== fromAddress ? { name: fromName } : {}),
          },
        }
      : {}),
    to: addressesOf(message.toRecipients),
    cc: addressesOf(message.ccRecipients),
    ...(subject ? { subject } : {}),
    bodyText: bodyTextOf(message).slice(0, BODY_TEXT_MAX),
    labels,
    attachments,
    backfill,
  };
}

/** A Graph link (nextLink, deltaLink) as a proxy request: path plus its own query. */
export function requestOfLink(link: string): { endpoint: string; params: Record<string, string> } {
  const url = new URL(link);
  return { endpoint: url.pathname, params: Object.fromEntries(url.searchParams) };
}
