import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAction } from '../feed/actions.ts';
import { listAuditLog } from '../feed/audit.ts';
import { getCard } from '../feed/cards.ts';
import { addEntityExternalRef, getConnection } from '../feed/connections.ts';
import { asUser, createTestConnection, system } from '../feed/test-fixtures.ts';
import { createDocument, getDocument } from '../knowledge/documents.ts';
import { confirmFact, createFact } from '../knowledge/facts.ts';
import { sha256 } from '../knowledge/test-fixtures.ts';
import { addEntityIdentifier, createEntity, getEntity } from '../memory/entities.ts';
import { getEvent, getEventContent, linkEventEntity, recordEvent } from '../memory/events.ts';
import { openTestDatabases, type TestTenant } from '../test-support.ts';
import { type TenantTransaction, withTenant } from '../with-tenant.ts';
import { disconnectConnection, purgeConnection } from './purge.ts';
import { personMarkers, seedPerson } from './test-fixtures.ts';

// Disconnecting a connection (docs/data-model.md connections, §6.3): revoked,
// then the data that came through it is deleted and it becomes purged.

const db = openTestDatabases();
let tenant: TestTenant;
let other: TestTenant;

const inTenant = <T>(fn: (tx: TenantTransaction) => Promise<T>) =>
  withTenant(db.app.db, tenant.tenantId, fn);

beforeAll(async () => {
  tenant = await db.createTenant();
  other = await db.createTenant();
});
afterAll(() => db.close());

/** A mail through `connectionId` from a new contact. */
async function mailFrom(tx: TenantTransaction, connectionId: string, name: string) {
  const contact = await createEntity(tx, { type: 'contact', name });
  const { event } = await recordEvent(tx, {
    event: {
      source: 'gmail',
      externalId: `message-${randomUUID()}`,
      type: 'email.received',
      occurredAt: new Date(),
      connectionId,
      payload: {},
    },
    content: { bodyText: `Groeten, ${name}` },
  });
  await linkEventEntity(tx, {
    eventId: event.id,
    entityId: contact.id,
    role: 'sender',
    linkedBy: 'rule',
  });
  return { contact, event };
}

describe('purgeConnection', () => {
  it('refuses an active connection and deletes nothing', async () => {
    const { world } = await inTenant(async (tx) => ({
      world: await seedPerson(tx, tenant, personMarkers()),
    }));
    await expect(
      inTenant((tx) => purgeConnection(tx, { connectionId: world.gmail.id, actor: system })),
    ).rejects.toMatchObject({ name: 'TransitionError', code: 'invalid_transition' });
    expect(await inTenant((tx) => getEvent(tx, world.mail.id))).toBeDefined();
  });

  it('deletes what came through the connection; shared entities and other connections stay', async () => {
    const user = asUser(tenant.userId);
    const world = await inTenant(async (tx) => {
      const seeded = await seedPerson(tx, tenant, personMarkers());
      const outlook = await createTestConnection(tx, tenant);
      // Only known through the purged mailbox: removed.
      const stranger = await mailFrom(tx, seeded.gmail.id, 'Nieuwsbrief BV');
      // Also mailed through another mailbox: stays.
      const shared = await mailFrom(tx, seeded.gmail.id, 'Piet Gedeeld');
      const { event: otherMail } = await recordEvent(tx, {
        event: {
          source: 'outlook',
          externalId: `message-${randomUUID()}`,
          type: 'email.received',
          occurredAt: new Date(),
          connectionId: outlook.id,
          payload: {},
        },
      });
      await linkEventEntity(tx, {
        eventId: otherMail.id,
        entityId: shared.contact.id,
        role: 'sender',
        linkedBy: 'rule',
      });
      // A user-confirmed fact keeps an entity, even without events.
      const known = await mailFrom(tx, seeded.gmail.id, 'Klaas Bekend');
      const fact = await createFact(tx, {
        entityId: known.contact.id,
        statement: 'Vaste klant sinds 2015',
        source: { sourceType: 'user', sourceUserId: tenant.userId },
      });
      await confirmFact(tx, { factId: fact.id, actor: user });
      // An identifier the user typed keeps an entity too.
      const typed = await mailFrom(tx, seeded.gmail.id, 'Truus Getypt');
      await addEntityIdentifier(tx, {
        entityId: typed.contact.id,
        identifier: { kind: 'email', value: `truus-${randomUUID()}@example.test` },
        source: { sourceType: 'user', sourceUserId: tenant.userId },
      });
      // A Moneybird-only contact, through the other connection: untouched.
      const customer = await createEntity(tx, { type: 'company', name: 'Klant BV' });
      await addEntityExternalRef(tx, {
        entityId: customer.id,
        connectionId: seeded.moneybird.id,
        objectType: 'contact',
        externalId: `contact-${randomUUID()}`,
      });
      const { document } = await createDocument(tx, {
        origin: 'connection',
        connectionId: seeded.gmail.id,
        externalId: `attachment-${randomUUID()}`,
        title: 'Bijlage offerte',
        mimeType: 'application/pdf',
        byteSize: 10,
        sha256: sha256(randomUUID()),
      });
      return { ...seeded, outlook, stranger, shared, otherMail, known, typed, customer, document };
    });

    await inTenant((tx) => disconnectConnection(tx, { connectionId: world.gmail.id, actor: user }));
    const result = await inTenant((tx) =>
      purgeConnection(tx, { connectionId: world.gmail.id, actor: system }),
    );
    expect(result).toMatchObject({
      purged: true,
      connection: { status: 'purged', statusReason: 'data_purged', accountLabel: null },
      deleted: { events: 6, documents: 1, cards: 1 },
    });

    const after = await inTenant(async (tx) => ({
      mail: await getEvent(tx, world.mail.id),
      mailContent: await getEventContent(tx, world.mail.id),
      card: await getCard(tx, world.card.id),
      action: await getAction(tx, world.action.id),
      document: await getDocument(tx, world.document.id),
      stranger: await getEntity(tx, world.stranger.contact.id),
      shared: await getEntity(tx, world.shared.contact.id),
      otherMail: await getEvent(tx, world.otherMail.id),
      known: await getEntity(tx, world.known.contact.id),
      typed: await getEntity(tx, world.typed.contact.id),
      customer: await getEntity(tx, world.customer.id),
      moneybird: await getConnection(tx, world.moneybird.id),
      // Linked to the person through the Moneybird reference and other tables.
      person: await getEntity(tx, world.person.id),
    }));
    expect(after.mail).toBeUndefined();
    expect(after.mailContent).toBeUndefined();
    expect(after.card).toBeUndefined();
    expect(after.action).toBeUndefined();
    expect(after.document).toBeUndefined();
    expect(after.stranger).toBeUndefined();
    expect(after.shared).toBeDefined();
    expect(after.otherMail).toBeDefined();
    expect(after.known).toBeDefined();
    expect(after.typed).toBeDefined();
    expect(after.customer).toBeDefined();
    expect(after.moneybird?.status).toBe('active');
    expect(after.person).toBeDefined();

    const audit = await inTenant((tx) =>
      listAuditLog(tx, { objectType: 'connections', objectId: world.gmail.id }),
    );
    expect(audit.map((entry) => [entry.action, entry.toStatus])).toEqual([
      ['connection.created', 'active'],
      ['connection.revoked', 'revoked'],
      ['connection.purged', 'purged'],
    ]);
    expect(audit[2]?.metadata).toMatchObject({
      provider: 'gmail',
      reason: 'data_purged',
      deleted: result.purged ? result.deleted : {},
    });
  });

  it('a repeat does nothing; disconnecting again neither', async () => {
    const connection = await inTenant((tx) => createTestConnection(tx, tenant));
    const user = asUser(tenant.userId);
    await inTenant((tx) => disconnectConnection(tx, { connectionId: connection.id, actor: user }));
    await inTenant((tx) => purgeConnection(tx, { connectionId: connection.id, actor: system }));
    await expect(
      inTenant((tx) => purgeConnection(tx, { connectionId: connection.id, actor: system })),
    ).resolves.toMatchObject({ purged: false, connection: { status: 'purged' } });
    await expect(
      inTenant((tx) => disconnectConnection(tx, { connectionId: connection.id, actor: user })),
    ).resolves.toMatchObject({ status: 'purged' });
  });

  it('another tenant cannot disconnect or purge the connection', async () => {
    const connection = await inTenant((tx) => createTestConnection(tx, tenant));
    const asOther = <T>(fn: (tx: TenantTransaction) => Promise<T>) =>
      withTenant(db.app.db, other.tenantId, fn);
    await expect(
      asOther((tx) =>
        disconnectConnection(tx, { connectionId: connection.id, actor: asUser(other.userId) }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      asOther((tx) => purgeConnection(tx, { connectionId: connection.id, actor: system })),
    ).resolves.toEqual({ purged: false, connection: undefined });
    expect((await inTenant((tx) => getConnection(tx, connection.id)))?.status).toBe('active');
  });
});
