import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAuditLog } from '../feed/audit.ts';
import { asUser } from '../feed/test-fixtures.ts';
import { getDocument } from '../knowledge/documents.ts';
import { searchEmbeddings } from '../knowledge/embeddings.ts';
import { getFact } from '../knowledge/facts.ts';
import { model } from '../knowledge/test-fixtures.ts';
import { getEntity } from '../memory/entities.ts';
import { getEvent } from '../memory/events.ts';
import { openTestDatabases, type TestTenant } from '../test-support.ts';
import { type TenantTransaction, withTenant } from '../with-tenant.ts';
import { forgetEntity } from './forget.ts';
import { findEverywhere, personMarkers, seedPerson } from './test-fixtures.ts';

// Right to be forgotten (docs/data-model.md §6.3): after forgetEntity the
// person cannot be found in any tenant table, also not through vector search,
// while what is not about them stays. Runs as app_runtime, bound by RLS.

const db = openTestDatabases();
let tenant: TestTenant;
let other: TestTenant;
const markers = personMarkers();
let world: Awaited<ReturnType<typeof seedPerson>>;
let otherWorld: Awaited<ReturnType<typeof seedPerson>>;

const inTenant = <T>(fn: (tx: TenantTransaction) => Promise<T>) =>
  withTenant(db.app.db, tenant.tenantId, fn);

beforeAll(async () => {
  tenant = await db.createTenant();
  other = await db.createTenant();
  world = await inTenant((tx) => seedPerson(tx, tenant, markers, 1));
  // The same person, known to another tenant too.
  otherWorld = await withTenant(db.app.db, other.tenantId, (tx) =>
    seedPerson(tx, other, markers, 2),
  );
});
afterAll(() => db.close());

describe('forgetEntity', () => {
  it('the fixture leaves a trace of the person in every table that can hold one', async () => {
    const { found } = await inTenant((tx) => findEverywhere(tx, markers.marker));
    expect(Object.keys(found).sort()).toEqual(
      [
        'actions',
        'cards',
        'entities',
        'entity_identifiers',
        'event_contents',
        'events',
        'facts',
        'playbook_examples',
        'playbooks',
        'tasks',
      ].sort(),
    );
    const byId = await inTenant((tx) => findEverywhere(tx, world.person.id, ['audit_log']));
    expect(Object.keys(byId.found)).toEqual(
      expect.arrayContaining([
        'card_entities',
        'document_entities',
        'entities',
        'entity_external_refs',
        'entity_identifiers',
        'event_entities',
        'facts',
        'insights',
        'playbooks',
        'relations',
        'task_entities',
      ]),
    );
  });

  it('removes the person from every table, also from vector search', async () => {
    const before = await inTenant(async (tx) => ({
      facts: await searchEmbeddings(tx, 'fact', { model, embedding: world.factVector }),
      playbooks: await searchEmbeddings(tx, 'playbook', { model, embedding: world.playbookVector }),
    }));
    expect(before.facts.map((m) => m.ownerId)).toContain(world.fact.id);
    expect(before.playbooks.map((m) => m.ownerId)).toContain(world.playbook.id);

    const result = await inTenant((tx) =>
      forgetEntity(tx, { entityId: world.person.id, actor: asUser(tenant.userId) }),
    );
    expect(result).toEqual({ entities: 2, events: 1, cards: 2, tasks: 1 });

    const after = await inTenant(async (tx) => ({
      marker: await findEverywhere(tx, markers.marker),
      email: await findEverywhere(tx, markers.email),
      phone: await findEverywhere(tx, markers.phone),
      // audit_log keeps the id of what was forgotten, by design (#040).
      personId: await findEverywhere(tx, world.person.id, ['audit_log']),
      duplicateId: await findEverywhere(tx, world.duplicate.id, ['audit_log']),
      facts: await searchEmbeddings(tx, 'fact', { model, embedding: world.factVector }),
      playbooks: await searchEmbeddings(tx, 'playbook', { model, embedding: world.playbookVector }),
    }));
    expect(after.marker.tables.length).toBeGreaterThan(20);
    expect(after.marker.found).toEqual({});
    expect(after.email.found).toEqual({});
    expect(after.phone.found).toEqual({});
    expect(after.personId.found).toEqual({});
    expect(after.duplicateId.found).toEqual({});
    expect(after.facts.map((m) => m.ownerId)).not.toContain(world.fact.id);
    expect(after.playbooks.map((m) => m.ownerId)).not.toContain(world.playbook.id);
  });

  it('keeps what is not about the person', async () => {
    const kept = await inTenant(async (tx) => ({
      company: await getEntity(tx, world.company.id),
      companyMail: await getEvent(tx, world.companyMail.id),
      companyFact: await getFact(tx, world.companyFact.id),
      document: await getDocument(tx, world.document.id),
    }));
    expect(kept.company).toBeDefined();
    expect(kept.companyMail).toBeDefined();
    expect(kept.document).toBeDefined();
    // Its source was the forgotten mail; the reference is gone, the type stays.
    expect(kept.companyFact).toMatchObject({ sourceType: 'event', sourceEventId: null });
  });

  it('writes one audit entry with ids and counts, without personal data', async () => {
    const audit = await inTenant((tx) =>
      listAuditLog(tx, { objectType: 'entities', objectId: world.person.id }),
    );
    expect(audit).toMatchObject([
      {
        action: 'entity.forgotten',
        actorType: 'user',
        actorUserId: tenant.userId,
        metadata: { deleted: { entities: 2, events: 1, cards: 2, tasks: 1 } },
      },
    ]);
    const text = JSON.stringify(audit);
    expect(text).not.toContain(markers.marker);
    expect(text).not.toContain(markers.email);
  });

  it('a repeat finds nothing and changes nothing', async () => {
    await expect(
      inTenant((tx) =>
        forgetEntity(tx, { entityId: world.person.id, actor: asUser(tenant.userId) }),
      ),
    ).resolves.toBeNull();
  });

  it('leaves the same person in another tenant alone', async () => {
    const { found } = await withTenant(db.app.db, other.tenantId, (tx) =>
      findEverywhere(tx, markers.marker),
    );
    expect(found).toMatchObject({ entities: 2, events: 1, event_contents: 1 });
    // Tenant A cannot forget an entity of tenant B: it does not exist for A.
    await expect(
      inTenant((tx) =>
        forgetEntity(tx, { entityId: otherWorld.person.id, actor: asUser(tenant.userId) }),
      ),
    ).resolves.toBeNull();
    const still = await withTenant(db.app.db, other.tenantId, (tx) =>
      getEntity(tx, otherWorld.person.id),
    );
    expect(still).toBeDefined();
  });
});
