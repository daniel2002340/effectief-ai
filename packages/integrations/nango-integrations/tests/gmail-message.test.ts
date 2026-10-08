import { describe, expect, it } from 'vitest';
import { changesOf } from '../gmail/helpers/history.js';
import {
  BODY_TEXT_MAX,
  type GmailMessage,
  InboxMessage,
  isInboxMail,
  parseAddressList,
  toInboxMessage,
} from '../gmail/helpers/message.js';
import { htmlToText } from '../shared/text.js';

// The pure parts of the Gmail sync, with hand-made messages. The behaviour on
// real (anonymized) Gmail responses is in inbox-messages.test.ts.

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

function gmailMessage(
  payload: GmailMessage['payload'],
  labelIds = ['INBOX', 'UNREAD'],
): GmailMessage {
  return {
    id: 'm1',
    threadId: 't1',
    labelIds,
    internalDate: String(Date.UTC(2026, 9, 6, 8, 0)),
    payload: {
      ...payload,
      headers: [
        { name: 'From', value: '"Vries, Jan de" <Jan@Klant.example>' },
        { name: 'To', value: 'info@bedrijf.example, "Piet" <piet@bedrijf.example>' },
        { name: 'Cc', value: 'boekhouding@bedrijf.example' },
        { name: 'Subject', value: ' Offerte dakkapel ' },
        { name: 'Message-ID', value: '<abc@mail.example>' },
        { name: 'Received', value: 'from mail.example by mx.google.com' },
      ],
    },
  };
}

describe('htmlToText', () => {
  it('keeps the text, drops tags, styles and scripts, and decodes entities', () => {
    const html =
      '<html><head><style>p{color:red}</style><title>x</title></head><body>' +
      '<p>Beste&nbsp;Daniël,</p><div>Prijs: &euro;&#160;1.250 &amp; meer</div>' +
      '<ul><li>één</li><li>twee</li></ul><script>alert(1)</script>' +
      '<a href="https://x.example">Bekijk</a><br>Groet<img src="cid:logo"></body></html>';
    const text = htmlToText(html);
    expect(text).toBe('Beste Daniël,\n\nPrijs: € 1.250 & meer\n\n- één\n- twee\nBekijk\nGroet');
    expect(text).not.toMatch(/[<>]/);
  });
});

describe('parseAddressList', () => {
  it('splits on commas outside quotes and lower-cases addresses', () => {
    expect(
      parseAddressList(
        '"Vries, Jan de" <Jan@Klant.example>, piet@x.example, undisclosed-recipients:;',
      ),
    ).toEqual([
      { address: 'jan@klant.example', name: 'Vries, Jan de' },
      { address: 'piet@x.example' },
    ]);
  });
});

describe('toInboxMessage', () => {
  it('prefers the text/plain part and keeps only the fields of the model', () => {
    const record = toInboxMessage(
      gmailMessage({
        mimeType: 'multipart/alternative',
        parts: [
          {
            partId: '0',
            mimeType: 'text/plain',
            body: { size: 5, data: b64('Hallo\r\n\r\n\r\n\r\nDaar') },
          },
          { partId: '1', mimeType: 'text/html', body: { size: 9, data: b64('<p>Hallo</p>') } },
        ],
      }),
      false,
    );
    expect(InboxMessage.parse(record)).toEqual({
      id: 'm1',
      threadId: 't1',
      internetMessageId: '<abc@mail.example>',
      receivedAt: '2026-10-06T08:00:00.000Z',
      from: { address: 'jan@klant.example', name: 'Vries, Jan de' },
      to: ['info@bedrijf.example', 'piet@bedrijf.example'],
      cc: ['boekhouding@bedrijf.example'],
      subject: 'Offerte dakkapel',
      bodyText: 'Hallo\n\nDaar',
      labels: ['INBOX', 'UNREAD'],
      attachments: [],
      backfill: false,
    });
  });

  it('turns an HTML-only mail into text, without any tag', () => {
    const record = toInboxMessage(
      gmailMessage({
        mimeType: 'text/html',
        body: {
          size: 40,
          data: b64('<html><body><h1>Factuur</h1><p>Zie bijlage.</p></body></html>'),
        },
      }),
      true,
    );
    expect(record.bodyText).toBe('Factuur\n\nZie bijlage.');
    expect(record.backfill).toBe(true);
  });

  it('keeps attachments and inline images as metadata only, by partId', () => {
    const pdf = 'JVBERi0xLjQK'.repeat(50);
    const record = toInboxMessage(
      gmailMessage({
        mimeType: 'multipart/mixed',
        parts: [
          {
            partId: '0',
            mimeType: 'multipart/related',
            parts: [
              {
                partId: '0.0',
                mimeType: 'text/html',
                body: { size: 30, data: b64('<p>Zie <img src="cid:x"></p>') },
              },
              {
                partId: '0.1',
                mimeType: 'image/png',
                filename: 'logo.png',
                body: { size: 120, data: 'iVBORw0KGgoAAAANSUhEUg' },
              },
            ],
          },
          {
            partId: '1',
            mimeType: 'application/pdf',
            filename: 'offerte.pdf',
            body: { size: 48_213, attachmentId: 'ANGjdJ8-changes-on-every-fetch', data: pdf },
          },
        ],
      }),
      false,
    );
    expect(record.attachments).toEqual([
      { name: 'logo.png', mimeType: 'image/png', size: 120, attachmentId: '0.1' },
      { name: 'offerte.pdf', mimeType: 'application/pdf', size: 48_213, attachmentId: '1' },
    ]);
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('iVBORw0KGgo');
    expect(serialized).not.toContain('JVBERi0');
    expect(serialized).not.toMatch(/<\/?[a-z][a-z0-9]*[\s/>]/i);
  });

  it('keeps only system labels from the fixed list and caps the text', () => {
    const record = toInboxMessage(
      gmailMessage(
        { mimeType: 'text/plain', body: { size: 1, data: b64('x'.repeat(BODY_TEXT_MAX + 10)) } },
        ['INBOX', 'Label_123', 'CATEGORY_UPDATES', 'IMPORTANT'],
      ),
      false,
    );
    expect(record.labels).toEqual(['INBOX', 'CATEGORY_UPDATES', 'IMPORTANT']);
    expect(record.bodyText).toHaveLength(BODY_TEXT_MAX);
  });
});

describe('isInboxMail', () => {
  it('is inbox mail without spam, trash, Promotions and Social; Updates and Forums count', () => {
    expect(isInboxMail(['INBOX'])).toBe(true);
    expect(isInboxMail(['INBOX', 'CATEGORY_UPDATES'])).toBe(true);
    expect(isInboxMail(['INBOX', 'CATEGORY_FORUMS'])).toBe(true);
    expect(isInboxMail(['INBOX', 'CATEGORY_PROMOTIONS'])).toBe(false);
    expect(isInboxMail(['INBOX', 'CATEGORY_SOCIAL'])).toBe(false);
    expect(isInboxMail(['SENT'])).toBe(false);
    expect(isInboxMail(['TRASH'])).toBe(false);
    expect(isInboxMail(undefined)).toBe(false);
  });
});

describe('changesOf', () => {
  it('lets the last change of a message decide', () => {
    expect(
      changesOf({
        historyId: '200',
        history: [
          { messagesAdded: [{ message: { id: 'new', labelIds: ['INBOX', 'UNREAD'] } }] },
          {
            messagesAdded: [
              { message: { id: 'promo', labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] } },
            ],
          },
          { messagesAdded: [{ message: { id: 'sent', labelIds: ['SENT'] } }] },
          { messagesAdded: [{ message: { id: 'trashed', labelIds: ['INBOX'] } }] },
          { labelsAdded: [{ message: { id: 'trashed', labelIds: ['TRASH'] } }] },
          { labelsRemoved: [{ message: { id: 'archived', labelIds: ['IMPORTANT'] } }] },
          { messagesDeleted: [{ message: { id: 'gone' } }] },
          { labelsAdded: [{ message: { id: 'spam', labelIds: ['SPAM'] } }] },
        ],
      }),
    ).toEqual({ fetch: ['new'], remove: ['trashed', 'gone', 'spam'] });
  });
});
