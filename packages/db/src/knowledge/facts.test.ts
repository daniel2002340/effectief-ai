import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAuditLog } from '../feed/audit.ts';
import { createEntity } from '../memory/entities.ts';
import {
  checkViolation,
  openTestDatabases,
  permissionDenied,
  type TestTenant,
} from '../test-support.ts';
import { type TenantTransaction, withTenant } from '../with-tenant.ts';
import {
  confirmFact,
  createFact,
  type Fact,
  getFact,
  listCurrentFacts,
  rejectFact,
  replaceFact,
} from './facts.ts';

// Facts are never overwritten: replacing one ends the old fact (valid_to,
// superseded_by_id) and creates a new one, in one transaction. The old text
// stays as it was.

const db = openTestDatabases();
let tenant: TestTenant;
let user: { type: 'user'; userId: string };

beforeAll(async () => {
  tenant = await db.createTenant();
  user = { type: 'user', userId: tenant.userId };
});
afterAll(() => db.close());

const inTenant = <T>(fn: (tx: TenantTransaction) => Promise<T>) =>
  withTenant(db.app.db, tenant.tenantId, fn);

const integrityViolation = { cause: expect.objectContaining({ code: '23000' }) };
const uniqueViolation = { cause: expect.objectContaining({ code: '23505' }) };

async function confirmedFact(statement = 'Wil ’s ochtends gebeld worden', attribute?: string) {
  return inTenant(async (tx) => {
    const entity = await createEntity(tx, { type: 'contact', name: 'Jan Jansen' });
    const proposed = await createFact(tx, {
      entityId: entity.id,
      statement,
      attribute: attribute ?? 'preferred_contact_time',
      structured: { attribute: attribute ?? 'preferred_contact_time', value: 'ochtend' },
      confidence: 0.8,
      source: { sourceType: 'system', aiModel: 'test-model' },
    });
    const { fact } = await confirmFact(tx, { factId: proposed.id, actor: user });
    return fact;
  });
}

describe('createFact', () => {
  it('always creates a proposed fact, valid from now', async () => {
    const fact = await inTenant(async (tx) => {
      const entity = await createEntity(tx, { type: 'contact', name: 'Piet' });
      return createFact(tx, {
        entityId: entity.id,
        statement: 'Heeft een warmtepomp',
        structured: { attribute: 'heat_pump_year', value: 2019 },
        source: { sourceType: 'system' },
      });
    });
    expect(fact).toMatchObject({
      status: 'proposed',
      attribute: 'heat_pump_year',
      validTo: null,
      confirmedAt: null,
    });
  });

  it('rejects a structured attribute that differs from attribute', async () => {
    await expect(
      inTenant((tx) =>
        createFact(tx, {
          entityId: randomUUID(),
          statement: 'X',
          attribute: 'a',
          structured: { attribute: 'b', value: 1 },
          source: { sourceType: 'system' },
        }),
      ),
    ).rejects.toThrow(/structured.attribute/);
  });

  it('cannot be inserted as confirmed, also not with raw SQL', async () => {
    const entity = await inTenant((tx) => createEntity(tx, { type: 'contact', name: 'Kees' }));
    await expect(
      inTenant((tx) =>
        tx.execute(sql`insert into facts (entity_id, statement, status, confirmed_at, source_type)
                       values (${entity.id}, 'X', 'confirmed', now(), 'system')`),
      ),
    ).rejects.toMatchObject(integrityViolation);
  });
});

describe('replaceFact', () => {
  it('ends the old fact and creates a new, confirmed one; the old text is unchanged', async () => {
    const old = await confirmedFact();
    const { fact, replaced } = await inTenant((tx) =>
      replaceFact(tx, { factId: old.id, statement: 'Wil ’s middags gebeld worden', actor: user }),
    );

    const oldNow = await inTenant((tx) => getFact(tx, old.id));
    expect(oldNow).toMatchObject({
      statement: old.statement,
      structured: old.structured,
      status: 'confirmed',
      supersededById: fact.id,
    });
    expect(oldNow?.validTo).toBeInstanceOf(Date);
    expect(replaced).toMatchObject({ id: old.id, supersededById: fact.id });

    expect(fact).toMatchObject({
      entityId: old.entityId,
      statement: 'Wil ’s middags gebeld worden',
      attribute: old.attribute,
      status: 'confirmed',
      confirmedByUserId: tenant.userId,
      validTo: null,
      sourceType: 'user',
      sourceUserId: tenant.userId,
    });
    // No gap between the two: the new one starts when the old one ends.
    expect(fact.validFrom).toEqual(oldNow?.validTo);
  });

  it('leaves exactly one current fact for the entity and attribute', async () => {
    const old = await confirmedFact();
    const { fact } = await inTenant((tx) =>
      replaceFact(tx, { factId: old.id, statement: 'Belt liever niet', actor: user }),
    );
    const current = await inTenant((tx) => listCurrentFacts(tx, old.entityId));
    expect(current.map((f) => f.id)).toEqual([fact.id]);
  });

  it('writes the supersession and the confirmation to audit_log', async () => {
    const old = await confirmedFact();
    const { fact } = await inTenant((tx) =>
      replaceFact(tx, { factId: old.id, statement: 'Anders', actor: user }),
    );
    const [oldLog, newLog] = await inTenant((tx) =>
      Promise.all([
        listAuditLog(tx, { objectType: 'facts', objectId: old.id }),
        listAuditLog(tx, { objectType: 'facts', objectId: fact.id }),
      ]),
    );
    expect(oldLog.map((e) => [e.action, e.metadata])).toEqual([
      ['fact.confirmed', { entityId: old.entityId }],
      ['fact.superseded', { entityId: old.entityId, supersededById: fact.id }],
    ]);
    expect(newLog.map((e) => [e.action, e.actorType, e.actorUserId])).toEqual([
      ['fact.confirmed', 'user', tenant.userId],
    ]);
  });

  it('cannot replace the same fact twice', async () => {
    const old = await confirmedFact();
    await inTenant((tx) => replaceFact(tx, { factId: old.id, statement: 'Eerste', actor: user }));
    await expect(
      inTenant((tx) => replaceFact(tx, { factId: old.id, statement: 'Tweede', actor: user })),
    ).rejects.toMatchObject({ name: 'KnowledgeError', code: 'not_current' });
  });

  it('two concurrent replacements: one wins, the other fails, nothing half-done', async () => {
    const old = await confirmedFact();
    const results = await Promise.allSettled([
      inTenant((tx) => replaceFact(tx, { factId: old.id, statement: 'A', actor: user })),
      inTenant((tx) => replaceFact(tx, { factId: old.id, statement: 'B', actor: user })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const current = await inTenant((tx) => listCurrentFacts(tx, old.entityId));
    expect(current).toHaveLength(1);
  });

  it('only replaces a confirmed fact', async () => {
    const proposed = await inTenant(async (tx) => {
      const entity = await createEntity(tx, { type: 'contact', name: 'Els' });
      return createFact(tx, {
        entityId: entity.id,
        statement: 'X',
        source: { sourceType: 'system' },
      });
    });
    await expect(
      inTenant((tx) => replaceFact(tx, { factId: proposed.id, statement: 'Y', actor: user })),
    ).rejects.toMatchObject({ code: 'not_current' });
    await expect(
      inTenant((tx) => replaceFact(tx, { factId: randomUUID(), statement: 'Y', actor: user })),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('confirmFact', () => {
  it('ends the current confirmed fact with the same attribute', async () => {
    const old = await confirmedFact();
    const { fact, replaced } = await inTenant(async (tx) => {
      const proposed = await createFact(tx, {
        entityId: old.entityId,
        statement: 'Wil ’s avonds gebeld worden',
        attribute: 'preferred_contact_time',
        source: { sourceType: 'system' },
      });
      return confirmFact(tx, { factId: proposed.id, actor: user });
    });
    expect(replaced?.id).toBe(old.id);
    const oldNow = await inTenant((tx) => getFact(tx, old.id));
    expect(oldNow).toMatchObject({ supersededById: fact.id, statement: old.statement });
    expect(oldNow?.validTo).toBeInstanceOf(Date);
  });

  it('keeps facts without attribute side by side', async () => {
    const first = await confirmedFact();
    const second = await inTenant(async (tx) => {
      const proposed = await createFact(tx, {
        entityId: first.entityId,
        statement: 'Heeft een hond',
        source: { sourceType: 'system' },
      });
      return (await confirmFact(tx, { factId: proposed.id, actor: user })).fact;
    });
    const current = await inTenant((tx) => listCurrentFacts(tx, first.entityId));
    expect(current.map((f) => f.id).sort()).toEqual([first.id, second.id].sort());
  });

  it('refuses confirming twice and confirming a rejected fact', async () => {
    const fact = await confirmedFact();
    await expect(
      inTenant((tx) => confirmFact(tx, { factId: fact.id, actor: user })),
    ).rejects.toMatchObject({ name: 'TransitionError', code: 'status_changed' });

    const rejected = await inTenant(async (tx) => {
      const proposed = await createFact(tx, {
        entityId: fact.entityId,
        statement: 'Klopt niet',
        source: { sourceType: 'system' },
      });
      return rejectFact(tx, { factId: proposed.id, actor: user });
    });
    expect(rejected.status).toBe('rejected');
    await expect(
      inTenant((tx) => confirmFact(tx, { factId: rejected.id, actor: user })),
    ).rejects.toMatchObject({ code: 'status_changed' });
  });

  it('only a user confirms', async () => {
    const fact = await confirmedFact();
    await expect(
      inTenant((tx) =>
        // @ts-expect-error: an agent cannot confirm
        confirmFact(tx, { factId: fact.id, actor: { type: 'agent' } }),
      ),
    ).rejects.toThrow();
  });
});

describe('immutability in the database', () => {
  let fact: Fact;
  beforeAll(async () => {
    fact = await confirmedFact();
  });

  it.each([
    ['statement', `'Overschreven'`],
    ['attribute', `'other'`],
    ['structured', `'{}'::jsonb`],
    ['entity_id', 'entity_id'],
    ['valid_from', 'now()'],
    ['source_type', `'user'`],
    ['confidence', '1'],
    ['created_at', 'now()'],
  ])('facts.%s cannot be changed', async (column, value) => {
    await expect(
      inTenant((tx) =>
        tx.execute(
          sql`update facts set ${sql.identifier(column)} = ${sql.raw(value)} where id = ${fact.id}`,
        ),
      ),
    ).rejects.toMatchObject(permissionDenied);
  });

  it('facts cannot be deleted by the app', async () => {
    await expect(
      inTenant((tx) => tx.execute(sql`delete from facts where id = ${fact.id}`)),
    ).rejects.toMatchObject(permissionDenied);
  });

  it('an ended fact stays ended', async () => {
    const old = await confirmedFact();
    await inTenant((tx) => replaceFact(tx, { factId: old.id, statement: 'Nieuw', actor: user }));
    await expect(
      inTenant((tx) => tx.execute(sql`update facts set valid_to = null where id = ${old.id}`)),
    ).rejects.toMatchObject(integrityViolation);
    await expect(
      inTenant((tx) =>
        tx.execute(sql`update facts set superseded_by_id = ${fact.id} where id = ${old.id}`),
      ),
    ).rejects.toMatchObject(integrityViolation);
  });

  it('two current confirmed facts with the same attribute are impossible', async () => {
    const existing = await confirmedFact('Wil gemaild worden', 'preferred_channel');
    await expect(
      inTenant(async (tx) => {
        const proposed = await createFact(tx, {
          entityId: existing.entityId,
          statement: 'Wil gebeld worden',
          attribute: 'preferred_channel',
          source: { sourceType: 'system' },
        });
        await tx.execute(
          sql`update facts set status = 'confirmed', confirmed_at = now() where id = ${proposed.id}`,
        );
      }),
    ).rejects.toMatchObject(uniqueViolation);
  });

  it('confirmed needs confirmed_at, not the member (who may leave)', async () => {
    const proposed = await inTenant(async (tx) => {
      const entity = await createEntity(tx, { type: 'contact', name: 'Bas' });
      return createFact(tx, {
        entityId: entity.id,
        statement: 'X',
        source: { sourceType: 'system' },
      });
    });
    await expect(
      inTenant((tx) =>
        tx.execute(sql`update facts set status = 'confirmed' where id = ${proposed.id}`),
      ),
    ).rejects.toMatchObject(checkViolation);
  });
});
