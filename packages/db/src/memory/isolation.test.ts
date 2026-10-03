import { type SQL, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../index.ts';
import {
  foreignKeyViolation,
  openTestDatabases,
  permissionDenied,
  rlsViolation,
  type TestTenant,
} from '../test-support.ts';
import { withTenant } from '../with-tenant.ts';
import {
  addEntityIdentifier,
  createEntity,
  findEntityByIdentifier,
  getEntity,
  listEntityIdentifiers,
} from './entities.ts';
import { getEvent, getEventContent, linkEventEntity, listTimeline, recordEvent } from './events.ts';
import { createRelation, listRelations } from './relations.ts';
import { createTask, getTask, listTasks } from './tasks.ts';

// Tenant A must not read, change or delete tenant B's rows in any memory
// table, also not with raw SQL, and must not link its rows to B's rows.

const db = openTestDatabases();
let A: TestTenant;
let B: TestTenant;
let worldA: World;
let worldB: World;

type World = Awaited<ReturnType<typeof seedWorld>>;

function seedWorld({ tenantId, userId }: TestTenant) {
  return withTenant(db.app.db, tenantId, async (tx) => {
    const contact = await createEntity(tx, { type: 'contact', name: 'Jan Jansen' });
    const company = await createEntity(tx, { type: 'company', name: 'Bouw BV' });
    const email = `jan@bouw-${tenantId.slice(0, 8)}.nl`;
    await addEntityIdentifier(tx, {
      entityId: contact.id,
      identifier: { kind: 'email', value: email },
      source: { sourceType: 'system' },
    });
    const { event } = await recordEvent(tx, {
      event: {
        source: 'gmail',
        externalId: 'message-1',
        type: 'email.received',
        occurredAt: new Date(),
        payload: {},
      },
      content: { subject: 'Offerte', bodyText: 'Kunt u een offerte sturen?' },
    });
    await linkEventEntity(tx, {
      eventId: event.id,
      entityId: contact.id,
      role: 'sender',
      linkedBy: 'rule',
    });
    const relation = await createRelation(tx, {
      fromEntityId: contact.id,
      toEntityId: company.id,
      type: 'works_at',
      source: { sourceType: 'event', sourceEventId: event.id },
    });
    const { task } = await createTask(tx, {
      title: 'Jan terugbellen',
      createdBy: 'user',
      assigneeUserId: userId,
      entityIds: [contact.id],
      source: { sourceType: 'user', sourceUserId: userId },
    });
    return { contact, company, email, event, relation, task };
  });
}

beforeAll(async () => {
  A = await db.createTenant();
  B = await db.createTenant();
  worldA = await seedWorld(A);
  worldB = await seedWorld(B);
});

afterAll(() => db.close());

const asA = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db.app.db, A.tenantId, fn);
const asB = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db.app.db, B.tenantId, fn);
const rows = (result: { rows: unknown[] }) => result.rows as Record<string, unknown>[];

interface TableCase {
  table: string;
  /** A no-op UPDATE on a column the app may update, or null when it may update nothing. */
  update: string | null;
  canDelete: boolean;
  /** Inserts a row for `tenant`, referencing that tenant's world. */
  insert: (tenantId: string, world: World) => SQL;
}

const tables: TableCase[] = [
  {
    table: 'entities',
    update: 'name = name',
    canDelete: true,
    insert: (t) =>
      sql`insert into entities (tenant_id, type, name, attributes) values (${t}, 'contact', 'X', '{}')`,
  },
  {
    table: 'entity_identifiers',
    update: null,
    canDelete: true,
    insert: (t, w) =>
      sql`insert into entity_identifiers (tenant_id, entity_id, kind, value, source_type)
          values (${t}, ${w.company.id}, 'kvk', '12345678', 'system')`,
  },
  {
    table: 'relations',
    update: 'valid_to = valid_to',
    canDelete: false,
    insert: (t, w) =>
      sql`insert into relations (tenant_id, from_entity_id, to_entity_id, type, status, source_type)
          values (${t}, ${w.company.id}, ${w.contact.id}, 'client_of', 'proposed', 'system')`,
  },
  {
    table: 'events',
    update: 'summary = summary',
    canDelete: true,
    insert: (t) =>
      sql`insert into events (tenant_id, source, external_id, type, occurred_at, payload)
          values (${t}, 'app', 'x', 'note.added', now(), '{}')`,
  },
  {
    table: 'event_contents',
    update: null,
    canDelete: true,
    insert: (t, w) =>
      sql`insert into event_contents (tenant_id, event_id, retain_until) values (${t}, ${w.event.id}, now())`,
  },
  {
    table: 'event_entities',
    update: null,
    canDelete: true,
    insert: (t, w) =>
      sql`insert into event_entities (tenant_id, event_id, entity_id, role, linked_by)
          values (${t}, ${w.event.id}, ${w.company.id}, 'mentioned', 'ai')`,
  },
  {
    table: 'tasks',
    update: 'title = title',
    canDelete: true,
    insert: (t) =>
      sql`insert into tasks (tenant_id, title, created_by, source_type) values (${t}, 'X', 'user', 'system')`,
  },
  {
    table: 'task_entities',
    update: null,
    canDelete: true,
    insert: (t, w) =>
      sql`insert into task_entities (tenant_id, task_id, entity_id) values (${t}, ${w.task.id}, ${w.company.id})`,
  },
];

const countAll = (table: string) => sql`select count(*)::int as n from ${sql.identifier(table)}`;

describe.each(tables)('$table', ({ table, update, canDelete, insert }) => {
  const tableId = sql.identifier(table);

  it('a tenant sees only its own rows', async () => {
    const seen = await asA((tx) => tx.execute(sql`select distinct tenant_id from ${tableId}`));
    expect(rows(seen)).toEqual([{ tenant_id: A.tenantId }]);
  });

  it('a tenant cannot read another tenant with raw SQL', async () => {
    const seen = await asA((tx) =>
      tx.execute(sql`select * from ${tableId} where tenant_id = ${B.tenantId}`),
    );
    expect(seen.rows).toEqual([]);
  });

  it('a tenant cannot update another tenant', async () => {
    if (update === null) {
      await expect(
        asA((tx) => tx.execute(sql`update ${tableId} set tenant_id = tenant_id`)),
      ).rejects.toMatchObject(permissionDenied);
      return;
    }
    const result = await asA((tx) =>
      tx.execute(sql`update ${tableId} set ${sql.raw(update)} where tenant_id = ${B.tenantId}`),
    );
    expect(result.rowCount).toBe(0);
  });

  it('a tenant cannot delete another tenant', async () => {
    const before = rows(await asB((tx) => tx.execute(countAll(table))));
    const attempt = asA((tx) =>
      tx.execute(sql`delete from ${tableId} where tenant_id = ${B.tenantId}`),
    );
    if (canDelete) expect((await attempt).rowCount).toBe(0);
    else await expect(attempt).rejects.toMatchObject(permissionDenied);
    expect(rows(await asB((tx) => tx.execute(countAll(table))))).toEqual(before);
  });

  it('a tenant cannot insert a row for another tenant', async () => {
    await expect(asA((tx) => tx.execute(insert(B.tenantId, worldB)))).rejects.toMatchObject(
      rlsViolation,
    );
  });

  it('without tenant context nothing is visible and nothing can be written', async () => {
    expect(rows(await db.app.db.execute(countAll(table)))).toEqual([{ n: 0 }]);
    await expect(db.app.db.execute(insert(A.tenantId, worldA))).rejects.toThrow();
  });
});

describe('repository reads across tenants', () => {
  it('return nothing for ids of another tenant', async () => {
    await asA(async (tx) => {
      expect(await getEntity(tx, worldB.contact.id)).toBeUndefined();
      expect(await listEntityIdentifiers(tx, worldB.contact.id)).toEqual([]);
      expect(
        await findEntityByIdentifier(tx, { kind: 'email', value: worldB.email }),
      ).toBeUndefined();
      expect(await getEvent(tx, worldB.event.id)).toBeUndefined();
      expect(await getEventContent(tx, worldB.event.id)).toBeUndefined();
      expect(await listRelations(tx, worldB.contact.id)).toEqual([]);
      expect(await getTask(tx, worldB.task.id)).toBeUndefined();
    });
  });

  it('lists only own rows', async () => {
    await asA(async (tx) => {
      expect((await listTimeline(tx)).map((e) => e.id)).toEqual([worldA.event.id]);
      expect((await listTasks(tx)).map((t) => t.id)).toEqual([worldA.task.id]);
      expect((await tx.select().from(schema.entities)).map((e) => e.tenantId)).toEqual([
        A.tenantId,
        A.tenantId,
      ]);
    });
  });
});

describe('links between tenants', () => {
  // Composite foreign keys on (tenant_id, …): a row of A can only point to rows of A.
  it('an event of A cannot be linked to an entity of B', async () => {
    await expect(
      asA((tx) =>
        linkEventEntity(tx, {
          eventId: worldA.event.id,
          entityId: worldB.contact.id,
          role: 'mentioned',
          linkedBy: 'ai',
        }),
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
  });

  it('a relation of A cannot point to an entity of B', async () => {
    await expect(
      asA((tx) =>
        createRelation(tx, {
          fromEntityId: worldA.contact.id,
          toEntityId: worldB.company.id,
          type: 'works_at',
          source: { sourceType: 'system' },
        }),
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
  });

  it('a task of A cannot be linked to an entity of B', async () => {
    await expect(
      asA((tx) =>
        createTask(tx, {
          title: 'X',
          createdBy: 'user',
          entityIds: [worldB.contact.id],
          source: { sourceType: 'system' },
        }),
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
  });

  it('an identifier of A cannot belong to an entity of B', async () => {
    await expect(
      asA((tx) =>
        addEntityIdentifier(tx, {
          entityId: worldB.contact.id,
          identifier: { kind: 'kvk', value: '87654321' },
          source: { sourceType: 'system' },
        }),
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
  });

  it('knowledge of A cannot cite an event of B or a user of B as source', async () => {
    await expect(
      asA((tx) =>
        createTask(tx, {
          title: 'X',
          createdBy: 'ai',
          source: { sourceType: 'event', sourceEventId: worldB.event.id },
        }),
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
    await expect(
      asA((tx) =>
        createTask(tx, {
          title: 'X',
          createdBy: 'user',
          assigneeUserId: B.userId,
          source: { sourceType: 'user', sourceUserId: A.userId },
        }),
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
  });
});
