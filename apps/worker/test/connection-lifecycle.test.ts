import { randomUUID } from 'node:crypto';
import {
  createConnection,
  disconnectConnection,
  eq,
  expireConnection,
  getConnection,
  reactivateConnection,
  schema,
  type TenantTransaction,
  withTenant,
} from '@effectief/db';
import { asUser, openTestDatabases, type TestTenant } from '@effectief/db/testing';
import type { NangoRecord, NangoRecordsPage } from '@effectief/integrations/nango';
import { createFakeNango } from '@effectief/integrations/testing';
import type { InboxMessage, ReportError } from '@effectief/shared';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processMailIngestJob } from '../src/jobs/mail-ingest.ts';
import { processPurgeConnectionJob } from '../src/jobs/purge-connection.ts';

// The life of a mail connection with real mail in it (docs/integrations.md §5,
// #077): after disconnecting nothing of it remains, an expired connection is
// not read, re-authorizing resumes without duplicates, and connecting the same
// mailbox again never collides with the old connection.

const log = pino({ level: 'silent' });
const db = openTestDatabases();
const noReport: ReportError = () => {};
let tenant: TestTenant;

beforeAll(async () => {
  tenant = await db.createTenant();
});
afterAll(() => db.close());

const inTenant = <T>(fn: (tx: TenantTransaction) => Promise<T>) =>
  withTenant(db.app.db, tenant.tenantId, fn);

/** A marker that only exists in this test's mail, to search the database for. */
const marker = () => `merk-${randomUUID()}`;

function message(id: string, mark: string): InboxMessage {
  return {
    id,
    threadId: `t-${id}`,
    internetMessageId: `<${id}.${mark}@mail.example>`,
    receivedAt: '2026-10-06T08:00:00.000Z',
    from: { address: `${mark}@klant.example`, name: `Jan ${mark}` },
    to: ['info@bedrijf.example'],
    cc: [`collega-${mark}@klant.example`],
    subject: `Offerte ${mark}`,
    bodyText: `Kunt u een offerte sturen? ${mark}`,
    labels: ['INBOX', 'UNREAD'],
    attachments: [],
    backfill: false,
  };
}

const record = (fields: InboxMessage, cursor: string): NangoRecord => ({
  fields,
  cursor,
  deleted: false,
  pruned: false,
});

/** A fake Nango that serves pages per connection and records what it was asked. */
function fakeNango(pages: Record<string, NangoRecordsPage[]>) {
  const asked: { connectionId: string; cursor: string | null }[] = [];
  const deleted: string[] = [];
  const served: Record<string, number> = {};
  const nango = createFakeNango({
    listRecords: async (ref, { cursor }) => {
      asked.push({ connectionId: ref.connectionId, cursor });
      const index = served[ref.connectionId] ?? 0;
      served[ref.connectionId] = index + 1;
      return pages[ref.connectionId]?.[index] ?? { records: [], nextCursor: undefined };
    },
    pruneRecords: async () => ({ count: 0 }),
    deleteConnection: async (ref) => {
      deleted.push(ref.connectionId);
      return { deleted: true };
    },
  });
  return { nango, asked, deleted, pages };
}

const mailbox = (externalAccountId = `account-${randomUUID()}`) =>
  inTenant((tx) =>
    createConnection(tx, {
      provider: 'gmail',
      nangoIntegrationId: 'gmail',
      nangoConnectionId: randomUUID(),
      externalAccountId,
      accountLabel: 'info@bedrijf.example',
      connectedByUserId: tenant.userId,
      actor: asUser(tenant.userId),
    }),
  );

const ingest = (connectionId: string, nango: ReturnType<typeof fakeNango>['nango']) =>
  processMailIngestJob(
    { tenantId: tenant.tenantId, connectionId },
    { jobId: `ingest-${randomUUID()}` },
    { db: db.app.db, nango, log, reportError: noReport },
  );

const eventsOf = (connectionId: string) =>
  inTenant((tx) =>
    tx.select().from(schema.events).where(eq(schema.events.connectionId, connectionId)),
  );

async function disconnectAndPurge(
  connectionId: string,
  nango: ReturnType<typeof fakeNango>['nango'],
) {
  await inTenant((tx) => disconnectConnection(tx, { connectionId, actor: asUser(tenant.userId) }));
  return processPurgeConnectionJob(
    { tenantId: tenant.tenantId, connectionId },
    { jobId: `purge-${randomUUID()}` },
    { db: db.app.db, log, nango },
  );
}

describe('disconnecting', () => {
  it('leaves no event, content, link, cursor or card of the connection, and no personal data in the audit', async () => {
    const mark = marker();
    const connection = await mailbox();
    const other = await mailbox();
    const fake = fakeNango({
      [connection.nangoConnectionId]: [
        {
          records: [
            record(message(`m1-${mark}`, mark), 'c1'),
            record(message(`m2-${mark}`, mark), 'c2'),
          ],
          nextCursor: undefined,
        },
      ],
      [other.nangoConnectionId]: [
        { records: [record(message(`o1-${mark}`, 'ander'), 'o1')], nextCursor: undefined },
      ],
    });
    await ingest(connection.id, fake.nango);
    await ingest(other.id, fake.nango);
    // A problem card of this connection, to see it go too.
    await inTenant((tx) =>
      expireConnection(tx, { connectionId: connection.id, reason: 'invalid_grant' }),
    );
    const eventIds = (await eventsOf(connection.id)).map((event) => event.id);
    expect(eventIds).toHaveLength(2);

    const result = await disconnectAndPurge(connection.id, fake.nango);
    expect(result).toMatchObject({ purged: true, deleted: { events: 2, cards: 1 } });
    expect(fake.deleted).toEqual([connection.nangoConnectionId]);

    const left = await inTenant(async (tx) => ({
      events: await tx
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.connectionId, connection.id)),
      contents: (
        await tx.select({ id: schema.eventContents.eventId }).from(schema.eventContents)
      ).filter((row) => eventIds.includes(row.id)),
      links: (
        await tx.select({ id: schema.eventEntities.eventId }).from(schema.eventEntities)
      ).filter((row) => eventIds.includes(row.id)),
      cursors: await tx
        .select()
        .from(schema.syncCursors)
        .where(eq(schema.syncCursors.connectionId, connection.id)),
      cards: await tx
        .select({ id: schema.cards.id })
        .from(schema.cards)
        .where(eq(schema.cards.connectionId, connection.id)),
      connection: await getConnection(tx, connection.id),
      audit: await tx
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.objectId, connection.id)),
    }));
    expect(left.events).toEqual([]);
    expect(left.contents).toEqual([]);
    expect(left.links).toEqual([]);
    expect(left.cursors).toEqual([]);
    expect(left.cards).toEqual([]);
    expect(left.connection).toMatchObject({ status: 'purged', accountLabel: null });

    // Nowhere in the tenant's mail tables is a trace of the mail itself.
    const contentsWithMark = await inTenant((tx) =>
      tx
        .select({ id: schema.eventContents.eventId, body: schema.eventContents.bodyText })
        .from(schema.eventContents),
    );
    expect(contentsWithMark.filter((row) => row.body?.includes(mark))).toEqual([]);
    const identifiers = await inTenant((tx) =>
      tx.select({ value: schema.entityIdentifiers.value }).from(schema.entityIdentifiers),
    );
    expect(identifiers.filter((row) => row.value.includes(mark))).toEqual([]);
    // The audit keeps what happened, with counts only.
    const audit = JSON.stringify(left.audit);
    expect(audit).not.toContain(mark);
    expect(audit).not.toContain('info@bedrijf.example');

    // The other mailbox keeps its mail.
    expect(await eventsOf(other.id)).toHaveLength(1);
  });
});

describe('expired and re-authorized', () => {
  it('is not read while expired, and resumes from its cursor without duplicates', async () => {
    const mark = marker();
    const connection = await mailbox();
    const fake = fakeNango({
      [connection.nangoConnectionId]: [
        {
          records: [
            record(message(`m1-${mark}`, mark), 'c1'),
            record(message(`m2-${mark}`, mark), 'c2'),
          ],
          nextCursor: undefined,
        },
        // After the reconnect Nango hands m2 again (a label change) and a new m3.
        {
          records: [
            record(message(`m2-${mark}`, mark), 'c3'),
            record(message(`m3-${mark}`, mark), 'c4'),
          ],
          nextCursor: undefined,
        },
      ],
    });
    await ingest(connection.id, fake.nango);
    expect(await eventsOf(connection.id)).toHaveLength(2);

    await inTenant((tx) =>
      expireConnection(tx, { connectionId: connection.id, reason: 'invalid_grant' }),
    );
    fake.asked.length = 0;
    expect(await ingest(connection.id, fake.nango)).toEqual({ result: 'not_active' });
    expect(fake.asked).toEqual([]);

    await inTenant((tx) =>
      reactivateConnection(tx, { connectionId: connection.id, reason: 'reauthorized' }),
    );
    expect(await ingest(connection.id, fake.nango)).toMatchObject({
      result: 'ingested',
      created: 1,
    });
    expect(fake.asked[0]).toEqual({ connectionId: connection.nangoConnectionId, cursor: 'c2' });
    const ids = (await eventsOf(connection.id)).map((event) => event.externalId).sort();
    expect(ids).toEqual([`m1-${mark}`, `m2-${mark}`, `m3-${mark}`]);
  });
});

describe('the same mailbox connected again after disconnecting', () => {
  it('is a new connection that waits for the old purge, then takes in all mail itself', async () => {
    const mark = marker();
    const account = `account-${randomUUID()}`;
    const first = await mailbox(account);
    const firstMail = [
      record(message(`m1-${mark}`, mark), 'c1'),
      record(message(`m2-${mark}`, mark), 'c2'),
    ];
    const fake = fakeNango({
      [first.nangoConnectionId]: [{ records: firstMail, nextCursor: undefined }],
    });
    await ingest(first.id, fake.nango);
    await inTenant((tx) =>
      disconnectConnection(tx, { connectionId: first.id, actor: asUser(tenant.userId) }),
    );

    // Connected again before the purge ran: allowed, a connection of its own.
    const second = await mailbox(account);
    expect(second.id).not.toBe(first.id);
    fake.pages[second.nangoConnectionId] = [
      {
        records: [...firstMail, record(message(`m3-${mark}`, mark), 'c3')],
        nextCursor: undefined,
      },
    ];
    fake.asked.length = 0;
    expect(await ingest(second.id, fake.nango)).toEqual({ result: 'awaiting_purge' });
    expect(fake.asked).toEqual([]);

    await processPurgeConnectionJob(
      { tenantId: tenant.tenantId, connectionId: first.id },
      { jobId: 'purge-first' },
      { db: db.app.db, log, nango: fake.nango },
    );
    expect(await ingest(second.id, fake.nango)).toMatchObject({ result: 'ingested', created: 3 });
    expect(await eventsOf(first.id)).toEqual([]);
    expect((await eventsOf(second.id)).map((event) => event.externalId).sort()).toEqual([
      `m1-${mark}`,
      `m2-${mark}`,
      `m3-${mark}`,
    ]);
    expect(await inTenant((tx) => getConnection(tx, first.id))).toMatchObject({
      status: 'purged',
    });
  });
});
