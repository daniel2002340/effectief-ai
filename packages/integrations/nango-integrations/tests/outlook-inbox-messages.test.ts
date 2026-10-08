import { describe, expect, it } from 'vitest';
import {
  attachmentsOf,
  type GraphMessage,
  InboxMessage,
  requestOfLink,
  toInboxMessage,
} from '../outlook/helpers/message.js';
import sync from '../outlook/syncs/inbox-messages.js';

// The Outlook sync against HAND-MADE Graph responses, shaped after the
// Microsoft Graph docs (message-delta, message-get, message-list-attachments).
// Recorded responses from a dry run on a real mailbox replace them before the
// sync is trusted (docs/todo.md); these tests pin the logic in the meantime.

const GRAPH = 'https://graph.microsoft.com';
const DELTA = '/v1.0/me/mailFolders/inbox/messages/delta';
const DELETED_ITEMS = 'folder-deleted';
const JUNK = 'folder-junk';
const ARCHIVE = 'folder-archive';

function graphMessage(id: string, overrides: Partial<GraphMessage> = {}): GraphMessage {
  return {
    id,
    conversationId: `conv-${id}`,
    internetMessageId: `<${id}@mail.example>`,
    receivedDateTime: '2026-10-06T08:00:00Z',
    from: { emailAddress: { address: 'jan@klant.example', name: 'Jan Klant' } },
    toRecipients: [{ emailAddress: { address: 'info@bedrijf.example', name: 'Info' } }],
    ccRecipients: [],
    subject: 'Offerte',
    body: { contentType: 'text', content: 'Kunt u een offerte sturen?\r\n\r\nGroet, Jan' },
    isRead: false,
    isDraft: false,
    hasAttachments: false,
    ...overrides,
  };
}

type Answer = { status?: number; data?: unknown };
/** The Graph query options the sync sends. */
type Params = { $select?: string; $filter?: string; $skiptoken?: string; $deltatoken?: string };

/** A `nango` whose GETs are answered by `route`, recording what the sync saves. */
function fakeNango(
  route: (endpoint: string, params: Params) => Answer,
  checkpoint: { link: string; backfill: boolean } | null = null,
) {
  const saved: InboxMessage[] = [];
  const deleted: string[] = [];
  const checkpoints: unknown[] = [];
  const requests: { endpoint: string; params: Params; headers?: unknown }[] = [];
  const nango = {
    get: async (config: {
      endpoint: string;
      params?: Record<string, string>;
      headers?: Record<string, string>;
    }) => {
      const params: Params = config.params ?? {};
      requests.push({ endpoint: config.endpoint, params, headers: config.headers });
      const answer = route(config.endpoint, params);
      if (answer.status && answer.status >= 400) {
        throw Object.assign(new Error('graph error'), { response: { status: answer.status } });
      }
      return { data: answer.data };
    },
    batchSave: async (records: InboxMessage[]) => {
      saved.push(...records.map((record) => InboxMessage.parse(record)));
    },
    batchDelete: async (records: { id: string }[]) => {
      deleted.push(...records.map((record) => record.id));
    },
    getCheckpoint: async () => checkpoint,
    saveCheckpoint: async (value: unknown) => {
      checkpoints.push(value);
    },
    log: async () => {},
  };
  // biome-ignore lint/suspicious/noExplicitAny: the Nango runtime type has far more than a test needs
  return { nango: nango as any, saved, deleted, checkpoints, requests };
}

const folders = (endpoint: string): Answer | undefined => {
  if (endpoint === '/v1.0/me/mailFolders/deleteditems') return { data: { id: DELETED_ITEMS } };
  if (endpoint === '/v1.0/me/mailFolders/junkemail') return { data: { id: JUNK } };
  return undefined;
};

describe('toInboxMessage', () => {
  it('keeps addresses only for recipients, the sender name, and unread as a label', () => {
    expect(toInboxMessage(graphMessage('m1'), [], true)).toEqual({
      id: 'm1',
      threadId: 'conv-m1',
      internetMessageId: '<m1@mail.example>',
      receivedAt: '2026-10-06T08:00:00.000Z',
      from: { address: 'jan@klant.example', name: 'Jan Klant' },
      to: ['info@bedrijf.example'],
      cc: [],
      subject: 'Offerte',
      bodyText: 'Kunt u een offerte sturen?\n\nGroet, Jan',
      labels: ['INBOX', 'UNREAD'],
      attachments: [],
      backfill: true,
    });
  });

  it('turns an HTML body into text when Graph sends HTML anyway', () => {
    const record = toInboxMessage(
      graphMessage('m2', {
        isRead: true,
        body: {
          contentType: 'html',
          content: '<html><body><p>Hallo&nbsp;Jan,</p><img src="cid:x"><p>Groet</p></body></html>',
        },
      }),
      [],
      false,
    );
    expect(record.bodyText).toBe('Hallo Jan,\n\nGroet');
    expect(record.labels).toEqual(['INBOX']);
  });

  it('copes with a sender without address and an empty body', () => {
    const record = toInboxMessage(
      graphMessage('m3', {
        from: { emailAddress: { name: 'Systeem' } },
        body: null,
        subject: null,
      }),
      [],
      false,
    );
    expect(record.from).toBeUndefined();
    expect(record.subject).toBeUndefined();
    expect(record.bodyText).toBe('');
  });
});

describe('attachmentsOf', () => {
  it('keeps metadata of real attachments, never inline images', () => {
    expect(
      attachmentsOf([
        {
          id: 'a1',
          name: 'offerte.pdf',
          contentType: 'application/pdf',
          size: 1234,
          isInline: false,
        },
        { id: 'a2', name: 'logo.png', contentType: 'image/png', size: 99, isInline: true },
      ]),
    ).toEqual([
      { name: 'offerte.pdf', mimeType: 'application/pdf', size: 1234, attachmentId: 'a1' },
    ]);
  });
});

describe('requestOfLink', () => {
  it('splits a Graph link into a path and its own query', () => {
    expect(
      requestOfLink(`${GRAPH}/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=abc%2Bdef`),
    ).toEqual({ endpoint: DELTA, params: { $deltatoken: 'abc+def' } });
  });
});

describe('outlook inbox-messages sync', () => {
  it('backfills 14 days as text, follows nextLink, and keeps the deltaLink', async () => {
    const { nango, saved, deleted, checkpoints, requests } = fakeNango((endpoint, params) => {
      if (endpoint === DELTA && params.$skiptoken === 'p2') {
        return {
          data: {
            value: [graphMessage('m2', { hasAttachments: true })],
            '@odata.deltaLink': `${GRAPH}${DELTA}?$deltatoken=d1`,
          },
        };
      }
      if (endpoint === DELTA) {
        return {
          data: {
            value: [graphMessage('m1'), graphMessage('draft', { isDraft: true })],
            '@odata.nextLink': `${GRAPH}${DELTA}?$skiptoken=p2`,
          },
        };
      }
      if (endpoint === '/v1.0/me/messages/m2/attachments') {
        return {
          data: {
            value: [
              {
                id: 'a1',
                name: 'tekening.pdf',
                contentType: 'application/pdf',
                size: 10,
                isInline: false,
              },
            ],
          },
        };
      }
      throw new Error(`unexpected ${endpoint}`);
    });
    await sync.exec(nango);

    const first = requests[0];
    expect(first?.endpoint).toBe(DELTA);
    expect(first?.params.$select).toContain('body');
    expect(first?.params.$filter).toMatch(/^receivedDateTime ge \d{4}-\d{2}-\d{2}T/);
    expect(first?.headers).toEqual({
      Prefer: 'outlook.body-content-type="text", odata.maxpagesize=50',
    });
    expect(saved.map((record) => [record.id, record.backfill])).toEqual([
      ['m1', true],
      ['m2', true],
    ]);
    expect(saved[1]?.attachments).toEqual([
      { name: 'tekening.pdf', mimeType: 'application/pdf', size: 10, attachmentId: 'a1' },
    ]);
    expect(deleted).toEqual([]);
    expect(checkpoints).toEqual([
      { link: `${GRAPH}${DELTA}?$skiptoken=p2`, backfill: true },
      { link: `${GRAPH}${DELTA}?$deltatoken=d1`, backfill: false },
    ]);
  });

  it('deletes what is gone or in Deleted Items or Junk, keeps what was archived', async () => {
    const { nango, saved, deleted, checkpoints } = fakeNango(
      (endpoint, params) => {
        const folder = folders(endpoint);
        if (folder) return folder;
        if (endpoint === DELTA && params.$deltatoken === 'd1') {
          return {
            data: {
              value: [
                graphMessage('new'),
                { id: 'trashed', '@removed': { reason: 'deleted' } },
                { id: 'junked', '@removed': { reason: 'deleted' } },
                { id: 'archived', '@removed': { reason: 'deleted' } },
                { id: 'purged', '@removed': { reason: 'deleted' } },
              ],
              '@odata.deltaLink': `${GRAPH}${DELTA}?$deltatoken=d2`,
            },
          };
        }
        const location: Record<string, Answer> = {
          '/v1.0/me/messages/trashed': { data: { parentFolderId: DELETED_ITEMS } },
          '/v1.0/me/messages/junked': { data: { parentFolderId: JUNK } },
          '/v1.0/me/messages/archived': { data: { parentFolderId: ARCHIVE } },
          '/v1.0/me/messages/purged': { status: 404 },
        };
        const answer = location[endpoint];
        if (answer) return answer;
        throw new Error(`unexpected ${endpoint}`);
      },
      { link: `${GRAPH}${DELTA}?$deltatoken=d1`, backfill: false },
    );
    await sync.exec(nango);

    expect(saved.map((record) => [record.id, record.backfill])).toEqual([['new', false]]);
    expect(deleted.sort()).toEqual(['junked', 'purged', 'trashed']);
    expect(checkpoints).toEqual([{ link: `${GRAPH}${DELTA}?$deltatoken=d2`, backfill: false }]);
  });

  it('starts over with 14 days when the delta token expired (410)', async () => {
    const { nango, saved, checkpoints, requests } = fakeNango(
      (endpoint, params) => {
        if (endpoint === DELTA && params.$deltatoken === 'old') return { status: 410 };
        if (endpoint === DELTA) {
          return {
            data: {
              value: [graphMessage('m1')],
              '@odata.deltaLink': `${GRAPH}${DELTA}?$deltatoken=fresh`,
            },
          };
        }
        throw new Error(`unexpected ${endpoint}`);
      },
      { link: `${GRAPH}${DELTA}?$deltatoken=old`, backfill: false },
    );
    await sync.exec(nango);

    expect(requests[1]?.params.$filter).toMatch(/^receivedDateTime ge /);
    expect(saved.map((record) => [record.id, record.backfill])).toEqual([['m1', true]]);
    expect(checkpoints).toEqual([
      { link: '', backfill: true },
      { link: `${GRAPH}${DELTA}?$deltatoken=fresh`, backfill: false },
    ]);
  });

  it('fails the run on other errors, without moving the checkpoint', async () => {
    const { nango, checkpoints } = fakeNango(() => ({ status: 503 }), {
      link: `${GRAPH}${DELTA}?$deltatoken=d1`,
      backfill: false,
    });
    await expect(sync.exec(nango)).rejects.toThrow('graph error');
    expect(checkpoints).toEqual([]);
  });
});
