import { randomUUID } from 'node:crypto';
import type { RecordEventInput } from '@effectief/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addEntityIdentifier, createEntity } from '../memory/entities.ts';
import { getEventContent } from '../memory/events.ts';
import { auditLog, eventEntities, events, syncCursors } from '../schema/index.ts';
import {
  foreignKeyViolation,
  openTestDatabases,
  rlsViolation,
  type TestTenant,
} from '../test-support.ts';
import { type TenantTransaction, withTenant } from '../with-tenant.ts';
import { listAuditLog } from './audit.ts';
import { expireConnection } from './connection-status.ts';
import { getConnection } from './connections.ts';
import { applyMailPage, getSyncCursor, type MailPageItem } from './mail-ingest.ts';
import { createTestConnection } from './test-fixtures.ts';

// One page of mail records in one transaction (docs/integrations.md §4.2,
// §4.5): events with content, links to known contacts, the cursor, and the
// audit counts; deleted mail loses its content; a moved cursor refuses the
// page; and tenant B never sees or moves tenant A's cursor.

const db = openTestDatabases();
let A: TestTenant;
let B: TestTenant;

const asA = <T>(fn: (tx: TenantTransaction) => Promise<T>) => withTenant(db.app.db, A.tenantId, fn);
const asB = <T>(fn: (tx: TenantTransaction) => Promise<T>) => withTenant(db.app.db, B.tenantId, fn);

beforeAll(async () => {
  A = await db.createTenant();
  B = await db.createTenant();
});
afterAll(() => db.close());

function mail(connectionId: string, externalId = `m-${randomUUID()}`): MailPageItem {
  const event: RecordEventInput = {
    event: {
      type: 'email.received',
      source: 'gmail',
      externalId,
      occurredAt: new Date('2026-10-06T08:00:00Z'),
      threadKey: 't1',
      internetMessageId: '<m1@mail.example>',
      connectionId,
      payload: { attachmentCount: 0, labels: ['INBOX', 'UNREAD'], backfill: false },
    },
    content: {
      fromAddress: 'jan@klant.example',
      fromName: 'Jan Klant',
      toAddresses: ['info@bedrijf.example'],
      ccAddresses: ['piet@klant.example'],
      subject: 'Offerte',
      bodyText: 'Kunt u een offerte sturen?',
      attachments: [],
    },
  };
  return {
    kind: 'message',
    event,
    senders: ['jan@klant.example'],
    recipients: ['info@bedrijf.example', 'piet@klant.example'],
  };
}

async function setup(tenant: TestTenant) {
  return withTenant(db.app.db, tenant.tenantId, async (tx) => {
    const connection = await createTestConnection(tx, tenant);
    const cursor = await getSyncCursor(tx, { connectionId: connection.id, model: 'InboxMessage' });
    return { connection, cursor };
  });
}

describe('applyMailPage', () => {
  it('records events with content, links known contacts and moves the cursor', async () => {
    const { connection, cursor } = await setup(A);
    expect(cursor).toBeNull();
    const contact = await asA(async (tx) => {
      const entity = await createEntity(tx, { type: 'contact', name: 'Jan Klant' });
      await addEntityIdentifier(tx, {
        entityId: entity.id,
        identifier: { kind: 'email', value: 'jan@klant.example' },
        source: { sourceType: 'user', sourceUserId: A.userId },
      });
      return entity;
    });
    const item = mail(connection.id);

    const result = await asA((tx) =>
      applyMailPage(tx, {
        connectionId: connection.id,
        model: 'InboxMessage',
        fromCursor: null,
        toCursor: 'c1',
        items: [item, item, { kind: 'invalid' }],
      }),
    );
    expect(result).toEqual({ applied: true, records: 3, created: 1, removed: 0, invalid: 1 });

    await asA(async (tx) => {
      const [event] = await tx.select().from(events).where(eq(events.connectionId, connection.id));
      expect(event?.internetMessageId).toBe('<m1@mail.example>');
      expect(event?.payload).toEqual({
        attachmentCount: 0,
        labels: ['INBOX', 'UNREAD'],
        backfill: false,
      });
      const content = await getEventContent(tx, event?.id ?? '');
      expect(content).toMatchObject({ fromName: 'Jan Klant', ccAddresses: ['piet@klant.example'] });
      const links = await tx
        .select()
        .from(eventEntities)
        .where(eq(eventEntities.eventId, event?.id ?? ''));
      expect(links).toEqual([
        expect.objectContaining({ entityId: contact.id, role: 'sender', linkedBy: 'rule' }),
      ]);
      expect(await getSyncCursor(tx, { connectionId: connection.id, model: 'InboxMessage' })).toBe(
        'c1',
      );
      expect((await getConnection(tx, connection.id))?.lastSyncedAt).toBeInstanceOf(Date);
      const audit = await listAuditLog(tx, { objectType: 'connections', objectId: connection.id });
      expect(audit.find((entry) => entry.action === 'mail.ingested')?.metadata).toEqual({
        provider: 'gmail',
        records: 3,
        created: 1,
        removed: 0,
        invalid: 1,
      });
    });
  });

  it('removes the content of a deleted mail and keeps the event', async () => {
    const { connection } = await setup(A);
    const item = mail(connection.id);
    const externalId = item.kind === 'message' ? item.event.event.externalId : '';
    await asA((tx) =>
      applyMailPage(tx, {
        connectionId: connection.id,
        model: 'InboxMessage',
        fromCursor: null,
        toCursor: 'c1',
        items: [item],
      }),
    );
    const result = await asA((tx) =>
      applyMailPage(tx, {
        connectionId: connection.id,
        model: 'InboxMessage',
        fromCursor: 'c1',
        toCursor: 'c2',
        items: [{ kind: 'removed', source: 'gmail', externalId }],
      }),
    );
    expect(result).toMatchObject({ applied: true, removed: 1 });
    await asA(async (tx) => {
      const [event] = await tx.select().from(events).where(eq(events.externalId, externalId));
      expect(event).toBeDefined();
      expect(await getEventContent(tx, event?.id ?? '')).toBeUndefined();
      const [removed] = await tx
        .select({ metadata: auditLog.metadata })
        .from(auditLog)
        .where(eq(auditLog.action, 'mail.content_removed'));
      expect(removed?.metadata).toEqual({ provider: 'gmail', count: 1 });
    });
  });

  it('refuses a page when another ingest moved the cursor', async () => {
    const { connection } = await setup(A);
    const page = (fromCursor: string | null, toCursor: string) =>
      asA((tx) =>
        applyMailPage(tx, {
          connectionId: connection.id,
          model: 'InboxMessage',
          fromCursor,
          toCursor,
          items: [mail(connection.id)],
        }),
      );
    expect(await page(null, 'c1')).toMatchObject({ applied: true });
    expect(await page(null, 'c1-again')).toEqual({ applied: false });
    expect(
      await asA((tx) => getSyncCursor(tx, { connectionId: connection.id, model: 'InboxMessage' })),
    ).toBe('c1');
  });

  it('leaves the cursor, the events and last_synced_at unchanged when saving a page fails', async () => {
    const { connection } = await setup(A);
    const foreign = await asB((tx) => createTestConnection(tx, B));
    const first = mail(connection.id);
    // The second record fails on insert (a connection of another tenant): the whole page rolls back.
    const failing = mail(foreign.id);
    await expect(
      asA((tx) =>
        applyMailPage(tx, {
          connectionId: connection.id,
          model: 'InboxMessage',
          fromCursor: null,
          toCursor: 'c1',
          items: [first, failing],
        }),
      ),
    ).rejects.toMatchObject(foreignKeyViolation);

    await asA(async (tx) => {
      expect(await getSyncCursor(tx, { connectionId: connection.id, model: 'InboxMessage' })).toBe(
        null,
      );
      expect(await tx.select().from(events).where(eq(events.connectionId, connection.id))).toEqual(
        [],
      );
      expect((await getConnection(tx, connection.id))?.lastSyncedAt).toBeNull();
      const audit = await listAuditLog(tx, { objectType: 'connections', objectId: connection.id });
      expect(audit.some((entry) => entry.action === 'mail.ingested')).toBe(false);
    });

    // The next run reads the same page again from the old cursor.
    expect(
      await asA((tx) =>
        applyMailPage(tx, {
          connectionId: connection.id,
          model: 'InboxMessage',
          fromCursor: null,
          toCursor: 'c1',
          items: [first],
        }),
      ),
    ).toMatchObject({ applied: true, created: 1 });
  });

  it('takes in nothing for a connection that is no longer active', async () => {
    const { connection } = await setup(A);
    await asA((tx) =>
      expireConnection(tx, { connectionId: connection.id, reason: 'invalid_grant' }),
    );
    expect(
      await asA((tx) =>
        applyMailPage(tx, {
          connectionId: connection.id,
          model: 'InboxMessage',
          fromCursor: null,
          toCursor: 'c1',
          items: [mail(connection.id)],
        }),
      ),
    ).toEqual({ applied: false });
  });
});

describe('sync_cursors isolation', () => {
  it('tenant B cannot read, move or create a cursor of tenant A', async () => {
    const { connection } = await setup(A);
    await asA((tx) =>
      applyMailPage(tx, {
        connectionId: connection.id,
        model: 'InboxMessage',
        fromCursor: null,
        toCursor: 'secret-cursor',
        items: [],
      }),
    );
    await asB(async (tx) => {
      expect(await tx.select().from(syncCursors)).toEqual([]);
      const moved = await tx
        .update(syncCursors)
        .set({ cursor: 'b' })
        .where(eq(syncCursors.connectionId, connection.id))
        .returning();
      expect(moved).toEqual([]);
      expect(
        await applyMailPage(tx, {
          connectionId: connection.id,
          model: 'InboxMessage',
          fromCursor: 'secret-cursor',
          toCursor: 'b',
          items: [],
        }),
      ).toEqual({ applied: false });
    });
    await expect(
      asB((tx) =>
        tx.execute(
          sql`insert into sync_cursors (tenant_id, connection_id, model) values (${A.tenantId}, ${connection.id}, 'InboxMessage')`,
        ),
      ),
    ).rejects.toMatchObject(rlsViolation);
    expect(
      await asA((tx) => getSyncCursor(tx, { connectionId: connection.id, model: 'InboxMessage' })),
    ).toBe('secret-cursor');
  });

  it('tenant B cannot start a cursor on tenant A’s connection', async () => {
    const { connection } = await setup(A);
    await expect(
      asB((tx) => getSyncCursor(tx, { connectionId: connection.id, model: 'InboxMessage' })),
    ).rejects.toMatchObject(foreignKeyViolation);
  });
});
