import { readFileSync } from 'node:fs';
import { inboxMessageSchema } from '@effectief/shared';
import { describe, expect, it } from 'vitest';
import {
  cleanText,
  normalizeAddresses,
  normalizeInboxMessage,
  parseInboxRecord,
} from './normalize.ts';

// The app side of mail ingest (docs/integrations.md §3.1, §3.4): records as
// the Gmail sync makes them from real, anonymized responses
// (fixtures/gmail-records.json, kept equal to the sync by a test in
// nango-integrations), turned into event rows.

const records: unknown[] = JSON.parse(
  readFileSync(new URL('./fixtures/gmail-records.json', import.meta.url), 'utf8'),
);
const connectionId = '0199a1b2-0000-7000-8000-00000000c001';

/** A whole HTML tag; "<https://…>" and "<id@host>" are not. */
const TAG = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/i;

describe('normalizeInboxMessage on recorded Gmail records', () => {
  it('parses every record and makes rows without HTML or file content', () => {
    expect(records.length).toBeGreaterThan(0);
    for (const fields of records) {
      const message = parseInboxRecord(fields);
      expect(message).toBeDefined();
      if (!message) continue;
      const mail = normalizeInboxMessage(message, { source: 'gmail', connectionId });
      expect(mail).toBeDefined();
      const content = mail?.event.content;
      expect(content?.bodyText ?? '').not.toMatch(TAG);
      expect(content?.subject ?? '').not.toMatch(TAG);
      expect(JSON.stringify(mail)).not.toContain('iVBORw0KGgo');
      for (const attachment of content?.attachments ?? []) {
        expect(Object.keys(attachment).sort()).toEqual([
          'mimeType',
          'name',
          'providerAttachmentId',
          'size',
        ]);
      }
      expect(mail?.event.event).toMatchObject({
        type: 'email.received',
        source: 'gmail',
        externalId: message.id,
        threadKey: message.threadId,
        internetMessageId: message.internetMessageId,
        payload: { attachmentCount: message.attachments.length, backfill: true },
      });
      for (const address of [content?.fromAddress, ...(content?.toAddresses ?? [])]) {
        if (address) expect(address).toBe(address.toLowerCase());
      }
    }
  });

  it('refuses a record with a field beyond the model', () => {
    const [first] = records;
    expect(parseInboxRecord({ ...(first as object), html: '<p>x</p>' })).toBeUndefined();
    expect(inboxMessageSchema.safeParse(first).success).toBe(true);
  });
});

describe('internetMessageId', () => {
  const [first] = records;
  const eventWith = (internetMessageId: string | undefined) => {
    const message = parseInboxRecord({ ...(first as object), internetMessageId });
    if (!message) throw new Error('fixture does not parse');
    return normalizeInboxMessage(message, { source: 'gmail', connectionId })?.event.event;
  };

  it('keeps the Message-ID header on the event (#086)', () => {
    expect(eventWith(' <abc.123@mail.example> ')?.internetMessageId).toBe('<abc.123@mail.example>');
  });

  it('is null when missing, empty, too long or not one printable token', () => {
    expect(eventWith(undefined)?.internetMessageId).toBeNull();
    expect(eventWith('  ')?.internetMessageId).toBeNull();
    expect(eventWith(`<${'a'.repeat(998)}@x>`)?.internetMessageId).toBeNull();
    expect(eventWith('<a b@x>')?.internetMessageId).toBeNull();
  });
});

describe('cleanText', () => {
  it('removes leftover tags and inlined base64, and keeps angle-bracket text', () => {
    const base64 = Array.from({ length: 4 }, () => 'QUJD'.repeat(20)).join('\n');
    expect(cleanText(`Hallo<br>daar\n${base64}\nZie <https://x.example> en a < b`)).toBe(
      'Hallodaar\nZie <https://x.example> en a < b',
    );
  });
});

describe('normalizeAddresses', () => {
  it('lower-cases, deduplicates and drops what is not an address', () => {
    expect(normalizeAddresses([' Jan@X.example', 'jan@x.example', 'geen adres', 'a@b'])).toEqual([
      'jan@x.example',
    ]);
  });
});

describe('normalizeInboxMessage on recorded Outlook records', () => {
  // Made by the Outlook sync from real, anonymized Graph responses
  // (fixtures/outlook-records.json, kept equal by a test in nango-integrations).
  const outlookRecords: unknown[] = JSON.parse(
    readFileSync(new URL('./fixtures/outlook-records.json', import.meta.url), 'utf8'),
  );

  it('parses every record and keeps the long Graph ids', () => {
    expect(outlookRecords.length).toBeGreaterThan(0);
    let attachments = 0;
    for (const fields of outlookRecords) {
      const message = parseInboxRecord(fields);
      expect(message).toBeDefined();
      if (!message) continue;
      const mail = normalizeInboxMessage(message, { source: 'outlook', connectionId });
      expect(mail?.event.event).toMatchObject({ source: 'outlook', externalId: message.id });
      expect(mail?.event.content?.bodyText ?? '').not.toMatch(TAG);
      expect(mail?.event.content?.attachments).toHaveLength(message.attachments.length);
      attachments += message.attachments.length;
    }
    expect(attachments).toBe(1);
  });
});

describe('normalizeInboxMessage on an Outlook record', () => {
  // Graph ids are long base64 strings with "=", "+" and "-" (hand-made in that shape).
  const messageId = `AAMkAGI2THVSAAA=${'A'.repeat(120)}-Bq+x`;
  const attachmentId = `AAMkAGI2THVSAAABEgAQAMkpJI_X-LBFgvrv1PlZYd8=${'B'.repeat(100)}`;

  it('keeps the long message and attachment ids of Outlook', () => {
    const message = parseInboxRecord({
      id: messageId,
      threadId: 'AAQkAGI2THVSAAAQAPMr0pJdh8hPq0fF8NiRXZ4=',
      receivedAt: '2026-10-06T08:00:00.000Z',
      from: { address: 'Jan@Klant.example', name: 'Jan Klant' },
      to: ['info@bedrijf.example'],
      cc: [],
      subject: 'Offerte',
      bodyText: 'Kunt u een offerte sturen?',
      labels: ['INBOX', 'UNREAD'],
      attachments: [
        { name: 'offerte.pdf', mimeType: 'application/pdf', size: 1234, attachmentId },
        {
          name: 'raar.bin',
          mimeType: 'application/octet-stream',
          size: 1,
          attachmentId: 'met spatie',
        },
      ],
      backfill: false,
    });
    expect(message).toBeDefined();
    if (!message) return;
    const mail = normalizeInboxMessage(message, { source: 'outlook', connectionId });
    expect(mail?.event.event).toMatchObject({ source: 'outlook', externalId: messageId });
    expect(mail?.event.content?.attachments).toEqual([
      {
        name: 'offerte.pdf',
        mimeType: 'application/pdf',
        size: 1234,
        providerAttachmentId: attachmentId,
      },
    ]);
  });
});
