import {
  type AttachmentMeta,
  attachmentMetaSchema,
  type EventSource,
  type InboxMessage,
  inboxMessageSchema,
  providerAttachmentIdSchema,
  type RecordEventInput,
} from '@effectief/shared';

// From a Nango InboxMessage record to an event with source content
// (docs/integrations.md §3.4, §4.2). The Nango function already drops HTML
// and attachment content; this is the second line: a strict schema, and a
// check that strips leftover tags and base64 blocks from subject and text.
// Quotes and signatures stay for now (docs/todo.md).

/** Parses a record's fields; undefined when it does not match the model. */
export function parseInboxRecord(fields: unknown): InboxMessage | undefined {
  const parsed = inboxMessageSchema.safeParse(fields);
  return parsed.success ? parsed.data : undefined;
}

export interface NormalizedMail {
  event: RecordEventInput;
  /** For linking to entities that already have these addresses. */
  senders: string[];
  recipients: string[];
}

const MAX_ADDRESSES = 500;
const ADDRESS = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;

/** Lower case, trimmed, deduplicated; anything that is not an address is dropped. */
export function normalizeAddresses(addresses: readonly string[]): string[] {
  const result = new Set<string>();
  for (const raw of addresses) {
    const address = raw.trim().toLowerCase();
    if (address.length <= 320 && ADDRESS.test(address)) result.add(address);
    if (result.size === MAX_ADDRESSES) break;
  }
  return [...result];
}

/** HTML-like tags; "a < b" and "<jan@x.nl>" stay. */
const TAG = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi;
/** Three or more lines that are nothing but base64: an inlined file. */
const BASE64_BLOCK = /(?:^[ \t]*[A-Za-z0-9+/=_-]{60,}[ \t]*(?:\r?\n|$)){3,}/gm;

/** Text without leftover tags or inlined base64 (§3.1, "afgedwongen"). */
export function cleanText(text: string): string {
  return text
    .replace(BASE64_BLOCK, '')
    .replace(TAG, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A Message-ID: printable, no spaces, within one RFC 5322 line; anything else is dropped. */
const MESSAGE_ID = /^[\x21-\x7e]{1,998}$/;

const MIME_TYPE = /^[\w.+-]+\/[\w.+-]+$/;

function attachmentsOf(message: InboxMessage): AttachmentMeta[] {
  return message.attachments
    .filter((attachment) => providerAttachmentIdSchema.safeParse(attachment.attachmentId).success)
    .slice(0, 100)
    .map((attachment) =>
      attachmentMetaSchema.parse({
        name: attachment.name.trim().slice(0, 255) || 'bijlage',
        mimeType: MIME_TYPE.test(attachment.mimeType)
          ? attachment.mimeType.toLowerCase()
          : 'application/octet-stream',
        size: attachment.size,
        providerAttachmentId: attachment.attachmentId,
      }),
    );
}

export function normalizeInboxMessage(
  message: InboxMessage,
  {
    source,
    connectionId,
  }: { source: Extract<EventSource, 'gmail' | 'outlook'>; connectionId: string },
): NormalizedMail | undefined {
  const occurredAt = new Date(message.receivedAt);
  if (Number.isNaN(occurredAt.getTime())) return undefined;

  const [from] = normalizeAddresses(message.from ? [message.from.address] : []);
  const to = normalizeAddresses(message.to);
  const cc = normalizeAddresses(message.cc);
  const fromName = message.from?.name ? cleanText(message.from.name).slice(0, 320) : '';
  const subject = message.subject ? cleanText(message.subject).slice(0, 1000) : '';
  const attachments = attachmentsOf(message);
  const internetMessageId = message.internetMessageId?.trim() ?? '';

  return {
    event: {
      event: {
        type: 'email.received',
        source,
        externalId: message.id,
        occurredAt,
        threadKey: message.threadId.slice(0, 1000) || null,
        internetMessageId: MESSAGE_ID.test(internetMessageId) ? internetMessageId : null,
        connectionId,
        payload: {
          attachmentCount: attachments.length,
          labels: [...new Set(message.labels)],
          backfill: message.backfill,
        },
      },
      content: {
        fromAddress: from ?? null,
        fromName: fromName || null,
        toAddresses: to,
        ccAddresses: cc,
        subject: subject || null,
        bodyText: cleanText(message.bodyText) || null,
        attachments,
      },
    },
    senders: from ? [from] : [],
    recipients: [...new Set([...to, ...cc])],
  };
}
