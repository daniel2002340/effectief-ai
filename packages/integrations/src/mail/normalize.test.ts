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
