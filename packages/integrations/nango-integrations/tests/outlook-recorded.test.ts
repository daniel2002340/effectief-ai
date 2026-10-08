import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InboxMessage } from '../outlook/helpers/message.js';
import sync from '../outlook/syncs/inbox-messages.js';

// The Outlook sync against real Graph responses: recorded with
// `nango dryrun --save` on Daniël's Microsoft 365 mailbox on staging
// (2026-10-08) and anonymized with scripts/anonymize-outlook-mocks.ts
// (README.md). What they settled:
// - outlook-delta-read: a read/unread change comes as only `id` + `isRead`;
// - outlook-delta-read: with default ids, an archived message is not found
//   (404) after the move, as its id changed; hence immutable ids;
// - outlook-delta-moved: with immutable ids, archived is found elsewhere and
//   stays, deleted is found in Deleted Items and goes;
// - outlook-delta-expired: Graph answers 410 SyncStateInvalid to a token from
//   before the switch to immutable ids; the sync starts over with 14 days;
// - outlook-delta-new: attachment ids are 168 characters, with "=".

const GRAPH = 'https://graph.microsoft.com';
const INBOX_DELTA = "/v1.0/me/mailFolders('inbox')/messages/delta";

interface Mock {
  request?: { params?: Record<string, string> };
  response: unknown;
  status?: number;
}
interface Fixture {
  api: { get: Record<string, Mock | Mock[]> };
}

const loadFixture = (name: string): Fixture =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Fixture;

const mocksOf = (fixture: Fixture, endpoint: string): Mock[] => {
  const entry = fixture.api.get[endpoint];
  return Array.isArray(entry) ? entry : entry ? [entry] : [];
};

/** The checkpoint the recorded round started from: its delta token. */
function checkpointOf(fixture: Fixture) {
  const token = mocksOf(fixture, INBOX_DELTA)[0]?.request?.params?.['$deltatoken'];
  if (!token) throw new Error('fixture without a delta token');
  return { link: `${GRAPH}${INBOX_DELTA}?$deltatoken=${token}`, backfill: false };
}

/** A `nango` that answers from the fixture and records what the sync saves. */
function fakeNango(
  fixture: Fixture,
  checkpoint: { link: string; backfill: boolean } | null = null,
) {
  const saved: InboxMessage[] = [];
  const deleted: string[] = [];
  const checkpoints: unknown[] = [];
  const requested: { endpoint: string; prefer: string | undefined }[] = [];
  const nango = {
    get: async ({
      endpoint,
      params,
      headers,
    }: {
      endpoint: string;
      params?: Record<string, string>;
      headers?: Record<string, string>;
    }) => {
      requested.push({ endpoint, prefer: headers?.['Prefer'] });
      const candidates = mocksOf(fixture, endpoint);
      const mock =
        candidates.find(
          (candidate) =>
            JSON.stringify(candidate.request?.params ?? {}) === JSON.stringify(params ?? {}),
        ) ?? candidates[0];
      if (!mock)
        throw Object.assign(new Error(`no mock for ${endpoint}`), { response: { status: 404 } });
      if (mock.status && mock.status >= 400) {
        throw Object.assign(new Error('mock error'), {
          response: { status: mock.status, data: mock.response },
        });
      }
      return { data: mock.response };
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
  return { nango: nango as any, saved, deleted, checkpoints, requested };
}

/** A whole HTML tag; "<https://…>" and "<mailto:…>" are not. */
const TAG = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/i;

describe('outlook inbox-messages on recorded Graph responses', () => {
  it('backfill: strict records as text, then the deltaLink with backfill done', async () => {
    const fixture = loadFixture('outlook-backfill.json');
    const { nango, saved, deleted, checkpoints, requested } = fakeNango(fixture);
    await sync.exec(nango);

    expect(saved.length).toBeGreaterThan(0);
    for (const record of saved) {
      expect(record.backfill).toBe(true);
      expect(record.labels[0]).toBe('INBOX');
      expect(record.bodyText).not.toMatch(TAG);
    }
    expect(deleted).toEqual([]);
    expect(checkpoints).toEqual([
      { link: expect.stringContaining('$deltatoken='), backfill: false },
    ]);
    expect(requested.every((request) => request.prefer?.includes('IdType="ImmutableId"'))).toBe(
      true,
    );
  });

  it('new mail: records with attachment metadata only, ids of 150+ characters', async () => {
    const fixture = loadFixture('outlook-delta-new.json');
    const { nango, saved, deleted } = fakeNango(fixture, checkpointOf(fixture));
    await sync.exec(nango);

    expect(saved.map((record) => record.backfill)).toEqual(saved.map(() => false));
    const withAttachment = saved.filter((record) => record.attachments.length > 0);
    expect(withAttachment).toHaveLength(1);
    const [attachment] = withAttachment[0]?.attachments ?? [];
    expect(attachment).toEqual({
      name: 'bestand-1.pdf',
      mimeType: 'application/pdf',
      size: expect.any(Number),
      attachmentId: expect.stringMatching(/^[\w=+-]{150,}$/),
    });
    expect(JSON.stringify(saved)).not.toContain('contentBytes');
    expect(deleted).toEqual([]);
  });

  it('read/unread changes are skipped; with default ids a moved message is not found', async () => {
    const fixture = loadFixture('outlook-delta-read.json');
    const { nango, saved, deleted } = fakeNango(fixture, checkpointOf(fixture));
    await sync.exec(nango);

    expect(saved).toEqual([]);
    // Both moved messages were looked up and gave 404: the reason for immutable ids.
    expect(deleted).toHaveLength(2);
  });

  it('archived stays, deleted goes (immutable ids)', async () => {
    const fixture = loadFixture('outlook-delta-moved.json');
    const responseOf = (endpoint: string) =>
      (mocksOf(fixture, endpoint)[0]?.response ?? {}) as { id?: string; parentFolderId?: string };
    const deletedItems = responseOf('/v1.0/me/mailFolders/deleteditems').id;
    const lookups = Object.keys(fixture.api.get)
      .filter((endpoint) => endpoint.startsWith('/v1.0/me/messages/'))
      .map((endpoint) => ({
        id: decodeURIComponent(endpoint.slice('/v1.0/me/messages/'.length)),
        folder: responseOf(endpoint).parentFolderId,
      }));
    expect(lookups).toHaveLength(2);
    const trashed = lookups.filter((lookup) => lookup.folder === deletedItems);
    expect(trashed).toHaveLength(1);

    const { nango, saved, deleted } = fakeNango(fixture, checkpointOf(fixture));
    await sync.exec(nango);
    expect(saved).toEqual([]);
    expect(deleted).toEqual(trashed.map((lookup) => lookup.id));
  });

  it('an invalid delta token (410 SyncStateInvalid) starts over with 14 days', async () => {
    const fixture = loadFixture('outlook-delta-expired.json');
    const { nango, saved, checkpoints } = fakeNango(fixture, checkpointOf(fixture));
    await sync.exec(nango);

    expect(saved.length).toBeGreaterThan(0);
    expect(saved.every((record) => record.backfill)).toBe(true);
    expect(checkpoints).toEqual([
      { link: '', backfill: true },
      { link: expect.stringContaining('$deltatoken='), backfill: false },
    ]);
  });
});

// The app tests its normalization on the records this sync makes from the
// same responses (packages/integrations/src/mail/fixtures). Kept equal here;
// UPDATE_FIXTURES=1 rewrites the file after a change to the sync (then run
// `pnpm lint --write` for its formatting).
describe('outlook records fixture of the app', () => {
  it('equals what the sync saves for the backfill and the new mail', async () => {
    const backfill = fakeNango(loadFixture('outlook-backfill.json'));
    await sync.exec(backfill.nango);
    const fresh = loadFixture('outlook-delta-new.json');
    const delta = fakeNango(fresh, checkpointOf(fresh));
    await sync.exec(delta.nango);
    const saved = [...backfill.saved, ...delta.saved];

    const file = new URL('../../src/mail/fixtures/outlook-records.json', import.meta.url);
    if (process.env['UPDATE_FIXTURES'] === '1') {
      writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`);
    }
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(saved);
  });
});
