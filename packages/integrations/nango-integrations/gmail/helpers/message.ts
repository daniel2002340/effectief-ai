import * as z from 'zod';

// Turns a Gmail message (format=full) into an InboxMessage record
// (docs/integrations.md §3.1). Runs in the Nango function: the HTML, other
// MIME parts and inline images exist only in memory here and never reach a
// record. Attachments: metadata only, never fetched.

/** The Gmail system labels a record may carry; never names of the user's own labels. */
const inboxLabels = [
  'INBOX',
  'UNREAD',
  'IMPORTANT',
  'STARRED',
  'CATEGORY_PERSONAL',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
] as const;

/** Mail with one of these is not in the inbox for us (§3.1). */
const excludedLabels = ['SPAM', 'TRASH', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL'];

export const BODY_TEXT_MAX = 32_000;

export const InboxMessage = z.strictObject({
  id: z.string().describe('Gmail message id. Example: "19a0c4e2f1b3d5a7"'),
  threadId: z.string().describe('Gmail thread id. Example: "19a0c4e2f1b3d5a7"'),
  internetMessageId: z
    .string()
    .optional()
    .describe('The Message-ID header. Example: "<abc@mail.example>"'),
  receivedAt: z
    .string()
    .describe('ISO 8601, from internalDate. Example: "2026-10-06T08:15:00.000Z"'),
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
          'Stable reference to fetch it later: the Gmail partId (Gmail attachment ids change per fetch). Example: "1.2"',
        ),
    }),
  ),
  backfill: z.boolean().describe('True for mail from the first 14-day sync'),
});
export type InboxMessage = z.infer<typeof InboxMessage>;

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
  const labels = (message.labelIds ?? []).filter((label): label is (typeof inboxLabels)[number] =>
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
  if (plain?.body?.data) return normalizeWhitespace(decodeBase64Url(plain.body.data));
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

const entities: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  euro: '€',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const point =
        code[1] === 'x' || code[1] === 'X'
          ? Number.parseInt(code.slice(2), 16)
          : Number(code.slice(1));
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : match;
    }
    return entities[code.toLowerCase()] ?? match;
  });
}

/**
 * HTML to readable text: no tags, no styles or scripts, block elements as line
 * breaks, links as their text. Not a full HTML parser; enough for mail.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(
      /<\/?(p|div|tr|table|h[1-6]|ul|ol|blockquote|section|article|header|footer)\b[^>]*>/gi,
      '\n',
    )
    .replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(/<[^>]*>/g, '');
  return normalizeWhitespace(decodeEntities(text));
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
