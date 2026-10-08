import * as z from 'zod';
import {
  BODY_TEXT_MAX,
  type InboxLabel,
  InboxMessage,
  inboxLabels,
} from '../../shared/inbox-message.js';
import { htmlToText, plainText } from '../../shared/text.js';

export { BODY_TEXT_MAX, InboxMessage };

// Turns a Gmail message (format=full) into an InboxMessage record
// (docs/integrations.md §3.1). Runs in the Nango function: the HTML, other
// MIME parts and inline images exist only in memory here and never reach a
// record. Attachments: metadata only, never fetched.

/** Mail with one of these is not in the inbox for us (§3.1). */
const excludedLabels = ['SPAM', 'TRASH', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL'];

// The parts of a Gmail message we read; everything else is ignored.
interface GmailPart {
  partId?: string | undefined;
  mimeType?: string | undefined;
  filename?: string | undefined;
  headers?: { name: string; value: string }[] | undefined;
  body?:
    | { size?: number | undefined; data?: string | undefined; attachmentId?: string | undefined }
    | undefined;
  parts?: GmailPart[] | undefined;
}
const GmailPartSchema: z.ZodType<GmailPart> = z.lazy(() =>
  z.object({
    partId: z.string().optional(),
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    body: z
      .object({
        size: z.number().optional(),
        data: z.string().optional(),
        attachmentId: z.string().optional(),
      })
      .optional(),
    parts: z.array(GmailPartSchema).optional(),
  }),
);

export const GmailMessage = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
  internalDate: z.string(),
  payload: GmailPartSchema,
});
export type GmailMessage = z.infer<typeof GmailMessage>;

/** Whether a message with these labels belongs in the records (§3.2). */
export function isInboxMail(labelIds: readonly string[] | undefined): boolean {
  const labels = labelIds ?? [];
  return labels.includes('INBOX') && !labels.some((label) => excludedLabels.includes(label));
}

/** Trash or spam: the record goes (batchDelete), the mail is gone for us (§4.5). */
export function isRemoved(labelIds: readonly string[] | undefined): boolean {
  return (labelIds ?? []).some((label) => label === 'TRASH' || label === 'SPAM');
}

export function toInboxMessage(message: GmailMessage, backfill: boolean): InboxMessage {
  const headers = message.payload.headers ?? [];
  const header = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

  const [from] = parseAddressList(header('From') ?? '');
  const internetMessageId = header('Message-ID')?.trim();
  const subject = header('Subject')?.trim();
  const labels = (message.labelIds ?? []).filter((label): label is InboxLabel =>
    (inboxLabels as readonly string[]).includes(label),
  );

  return {
    id: message.id,
    threadId: message.threadId,
    ...(internetMessageId ? { internetMessageId } : {}),
    receivedAt: new Date(Number(message.internalDate)).toISOString(),
    ...(from ? { from: { address: from.address, ...(from.name ? { name: from.name } : {}) } } : {}),
    to: parseAddressList(header('To') ?? '').map((a) => a.address),
    cc: parseAddressList(header('Cc') ?? '').map((a) => a.address),
    ...(subject ? { subject } : {}),
    bodyText: bodyTextOf(message.payload).slice(0, BODY_TEXT_MAX),
    labels,
    attachments: attachmentsOf(message.payload),
    backfill,
  };
}

/** Every part, depth first. */
function walk(part: GmailPart): GmailPart[] {
  return [part, ...(part.parts ?? []).flatMap(walk)];
}

const isAttachment = (part: GmailPart) => Boolean(part.filename);

/** The text/plain part; without one, the HTML part as text. Never an attachment. */
function bodyTextOf(payload: GmailPart): string {
  const parts = walk(payload).filter((part) => !isAttachment(part) && part.body?.data);
  const plain = parts.find((part) => part.mimeType === 'text/plain');
  if (plain?.body?.data) return plainText(decodeBase64Url(plain.body.data));
  const html = parts.find((part) => part.mimeType === 'text/html');
  if (html?.body?.data) return htmlToText(decodeBase64Url(html.body.data));
  return '';
}

/**
 * Name, type, size and partId only; the content stays at Gmail. Gmail's
 * attachmentId changes with every fetch of the message, the partId does not.
 */
function attachmentsOf(payload: GmailPart): InboxMessage['attachments'] {
  return walk(payload)
    .filter((part) => isAttachment(part) && part.partId)
    .map((part) => ({
      name: (part.filename ?? '').slice(0, 255),
      mimeType: part.mimeType ?? 'application/octet-stream',
      size: part.body?.size ?? 0,
      attachmentId: part.partId ?? '',
    }));
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

export interface ParsedAddress {
  address: string;
  name?: string;
}

/**
 * An address header ("Jan <jan@x.nl>, \"Vries, Piet\" <piet@y.nl>, z@z.nl")
 * as addresses, lower case. Commas inside quotes or angle brackets do not
 * split. Entries without an @ are dropped.
 */
export function parseAddressList(header: string): ParsedAddress[] {
  const entries: string[] = [];
  let current = '';
  let quoted = false;
  let angle = false;
  for (const char of header) {
    if (char === '"') quoted = !quoted;
    else if (char === '<' && !quoted) angle = true;
    else if (char === '>' && !quoted) angle = false;
    if (char === ',' && !quoted && !angle) {
      entries.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  entries.push(current);

  const result: ParsedAddress[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const bracket = /^(.*)<([^<>]+)>\s*$/.exec(trimmed);
    const address = (bracket?.[2] ?? trimmed).trim().toLowerCase();
    if (!address.includes('@')) continue;
    const name = bracket?.[1]
      ?.trim()
      .replace(/^"(.*)"$/, '$1')
      .replace(/\\"/g, '"')
      .trim();
    result.push({ address, ...(name ? { name } : {}) });
  }
  return result;
}
