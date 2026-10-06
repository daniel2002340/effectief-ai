import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InboxMessage } from '../gmail/helpers/message.js';
import sync from '../gmail/syncs/inbox-messages.js';

// The sync against real Gmail responses: recorded with `nango dryrun --save`
// on Daniël's mailbox on staging (2026-10-06) and anonymized with
// scripts/anonymize-gmail-mocks.ts (README.md). One message per shape.

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

/** The message ids in gmail-backfill.json, by the shape Gmail returned. */
const backfill = {
  alternative: '1a1113792a2c4de0',
  htmlOnly: '1a110b5f99ca8a90',
  inlineImage: '1a110a2fa6066457',
  plainOnly: '1a11003f38e19aa1',
  pdfAttachment: '1a10b5df49420bf7',
  htmlInPlain: '1a10a685edc56675',
};

/** A `nango` that answers from the fixture and records what the sync saves. */
function fakeNango(fixture: Fixture, checkpoint: Record<string, string> | null = null) {
  const saved: InboxMessage[] = [];
  const deleted: string[] = [];
  const checkpoints: Record<string, string>[] = [];
  const nango = {
    get: async ({ endpoint, params }: { endpoint: string; params?: Record<string, string> }) => {
      const entry = fixture.api.get[endpoint];
      const candidates = Array.isArray(entry) ? entry : entry ? [entry] : [];
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
      saved.push(...records);
    },
    batchDelete: async (records: { id: string }[]) => {
      deleted.push(...records.map((record) => record.id));
    },
    getCheckpoint: async () => checkpoint,
    saveCheckpoint: async (value: Record<string, string>) => {
      checkpoints.push(value);
    },
    log: async () => {},
  };
  // biome-ignore lint/suspicious/noExplicitAny: the Nango runtime type has far more than a test needs
  return { nango: nango as any, saved, deleted, checkpoints };
}

/** A whole HTML tag; "<https://…>" and "<id@host>" are not. */
const TAG = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/i;

describe('inbox-messages on recorded Gmail responses: backfill', () => {
  it('saves every inbox message as a strict record, without HTML or file content', async () => {
    const fixture = loadFixture('gmail-backfill.json');
    const { nango, saved, deleted, checkpoints } = fakeNango(fixture);
    await sync.exec(nango);

    expect(saved.map((record) => record.id).sort()).toEqual(Object.values(backfill).sort());
    expect(deleted).toEqual([]);
    for (const record of saved) {
      expect(InboxMessage.parse(record)).toEqual(record);
      expect(record.backfill).toBe(true);
      expect(record.bodyText.length).toBeGreaterThan(0);
      expect(record.bodyText).not.toMatch(TAG);
      expect(record.subject ?? '').not.toMatch(TAG);
      // The anonymizer put this 1×1 PNG in place of every image: never in a record.
      expect(JSON.stringify(record)).not.toContain('iVBORw0KGgo');
    }

    const history = fixture.api.get['/gmail/v1/users/me/history'] as Mock;
    expect(checkpoints.at(-1)).toEqual({
      phase: 'history',
      historyId: (history.response as { historyId: string }).historyId,
      pageToken: '',
    });
  });

  it('turns an HTML-only mail and HTML in a text part into plain text', async () => {
    const { nango, saved } = fakeNango(loadFixture('gmail-backfill.json'));
    await sync.exec(nango);
    for (const id of [backfill.htmlOnly, backfill.htmlInPlain]) {
      const record = saved.find((candidate) => candidate.id === id);
      expect(record?.bodyText).toMatch(/lorem/);
      expect(record?.bodyText).not.toMatch(TAG);
    }
  });

  it('keeps attachments and inline images as metadata only, referenced by partId', async () => {
    const { nango, saved } = fakeNango(loadFixture('gmail-backfill.json'));
    await sync.exec(nango);
    const pdf = saved.find((record) => record.id === backfill.pdfAttachment);
    expect(pdf?.attachments).toContainEqual(
      expect.objectContaining({
        mimeType: 'application/pdf',
        attachmentId: expect.stringMatching(/^\d+(\.\d+)*$/),
      }),
    );
    const inline = saved.find((record) => record.id === backfill.inlineImage);
    expect(inline?.attachments).toContainEqual(expect.objectContaining({ mimeType: 'image/png' }));
    for (const record of saved) {
      for (const attachment of record.attachments) {
        expect(Object.keys(attachment).sort()).toEqual([
          'attachmentId',
          'mimeType',
          'name',
          'size',
        ]);
        expect(attachment.size).toBeGreaterThan(0);
      }
    }
    expect(saved.find((record) => record.id === backfill.plainOnly)?.attachments).toEqual([]);
  });
});

// The app tests its normalization on the records this sync makes from the
// same responses (packages/integrations/src/mail/fixtures). Kept equal here;
// UPDATE_FIXTURES=1 rewrites the file after a change to the sync (then run
// `pnpm lint --write` for its formatting).
describe('records fixture of the app', () => {
  it('equals what the sync saves for gmail-backfill.json', async () => {
    const { nango, saved } = fakeNango(loadFixture('gmail-backfill.json'));
    await sync.exec(nango);
    const file = new URL('../../src/mail/fixtures/gmail-records.json', import.meta.url);
    if (process.env['UPDATE_FIXTURES'] === '1') {
      writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`);
    }
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(saved);
  });
});
