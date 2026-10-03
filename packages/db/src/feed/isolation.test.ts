import { type SQL, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordEvent } from '../memory/events.ts';
import { createTask } from '../memory/tasks.ts';
import {
  foreignKeyViolation,
  openTestDatabases,
  permissionDenied,
  rlsViolation,
  type TestTenant,
} from '../test-support.ts';
import { withTenant } from '../with-tenant.ts';
import { getAction, listCardActions, proposeAction, transitionAction } from './actions.ts';
import { listAuditLog } from './audit.ts';
import { createCard, getCard, getCardLinks, linkCard, listFeed, transitionCard } from './cards.ts';
import {
  addEntityExternalRef,
  getConnection,
  listConnections,
  listEntityExternalRefs,
  transitionConnection,
} from './connections.ts';
import { agent, asUser, replyInput, seedFeed } from './test-fixtures.ts';
import { TransitionError } from './transition.ts';

// Tenant A must not read, change or delete tenant B's rows in any feed table,
// also not with raw SQL or through the transition functions, and must not
// link its rows to B's rows.

const db = openTestDatabases();
let A: TestTenant;
let B: TestTenant;
let worldA: World;
let worldB: World;

type World = Awaited<ReturnType<typeof seedWorld>>;

function seedWorld(tenant: TestTenant) {
  return withTenant(db.app.db, tenant.tenantId, async (tx) => {
    const feed = await seedFeed(tx, tenant);
    const { ref } = await addEntityExternalRef(tx, {
      entityId: feed.contact.id,
      connectionId: feed.connection.id,
      objectType: 'contact',
      externalId: '123',
    });
    return { ...feed, ref };
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
    table: 'connections',
    update: 'last_synced_at = last_synced_at',
    canDelete: false,
    insert: (t) =>
      sql`insert into connections (tenant_id, provider, nango_integration_id, nango_connection_id)
          values (${t}, 'mollie', 'mollie', ${`conn-${t}`})`,
  },
  {
    table: 'entity_external_refs',
    update: null,
    canDelete: true,
    insert: (t, w) =>
      sql`insert into entity_external_refs (tenant_id, entity_id, connection_id, provider, object_type, external_id)
          values (${t}, ${w.contact.id}, ${w.connection.id}, 'gmail', 'contact', 'x')`,
  },
  {
    table: 'cards',
    update: 'title = title',
    canDelete: true,
    insert: (t) =>
      sql`insert into cards (tenant_id, kind, title, payload) values (${t}, 'insight', 'X', '{}')`,
  },
  {
    table: 'card_events',
    update: null,
    canDelete: true,
    insert: (t, w) =>
      sql`insert into card_events (tenant_id, card_id, event_id) values (${t}, ${w.card.id}, ${w.event.id})`,
  },
  {
    table: 'card_entities',
    update: null,
    canDelete: true,
    insert: (t, w) =>
      sql`insert into card_entities (tenant_id, card_id, entity_id) values (${t}, ${w.card.id}, ${w.contact.id})`,
  },
  {
    table: 'actions',
    update: 'attempts = attempts',
    canDelete: false,
    insert: (t, w) =>
      sql`insert into actions (tenant_id, card_id, connection_id, type, proposed_input, input, idempotency_key)
          values (${t}, ${w.card.id}, ${w.connection.id}, 'email.reply', '{}', '{}', 'x')`,
  },
  {
    table: 'audit_log',
    update: null,
    canDelete: false,
    insert: (t) =>
      sql`insert into audit_log (tenant_id, actor_type, action, object_type, metadata)
          values (${t}, 'system', 'card.created', 'cards', '{"kind":"insight"}')`,
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
      expect(await getConnection(tx, worldB.connection.id)).toBeUndefined();
      expect(await listEntityExternalRefs(tx, worldB.contact.id)).toEqual([]);
      expect(await getCard(tx, worldB.card.id)).toBeUndefined();
      expect(await getCardLinks(tx, worldB.card.id)).toEqual({ eventIds: [], entityIds: [] });
      expect(await getAction(tx, worldB.action.id)).toBeUndefined();
      expect(await listCardActions(tx, worldB.card.id)).toEqual([]);
      expect(await listAuditLog(tx, { objectType: 'actions', objectId: worldB.action.id })).toEqual(
        [],
      );
    });
  });

  it('lists only own rows', async () => {
    await asA(async (tx) => {
      expect((await listConnections(tx)).map((c) => c.id)).toEqual([worldA.connection.id]);
      expect((await listFeed(tx)).map((c) => c.id)).toEqual([worldA.card.id]);
    });
  });
});

describe('status transitions across tenants', () => {
  // The guarded UPDATE runs under RLS: B's row does not exist for A.
  it('A cannot change the status of B rows', async () => {
    await expect(
      asA((tx) =>
        transitionConnection(tx, {
          connectionId: worldB.connection.id,
          from: 'active',
          to: 'revoked',
          reason: 'user_disconnected',
          actor: asUser(A.userId),
        }),
      ),
    ).rejects.toMatchObject({ name: 'TransitionError', code: 'not_found' });
    await expect(
      asA((tx) =>
        transitionCard(tx, {
          cardId: worldB.card.id,
          from: 'open',
          to: 'dismissed',
          actor: asUser(A.userId),
        }),
      ),
    ).rejects.toBeInstanceOf(TransitionError);
    await expect(
      asA((tx) =>
        transitionAction(tx, {
          actionId: worldB.action.id,
          from: 'concept',
          to: 'approved',
          actor: asUser(A.userId),
        }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });

    await asB(async (tx) => {
      expect((await getConnection(tx, worldB.connection.id))?.status).toBe('active');
      expect((await getCard(tx, worldB.card.id))?.status).toBe('open');
      expect((await getAction(tx, worldB.action.id))?.status).toBe('concept');
    });
  });

  it('a user of B cannot approve an action of A', async () => {
    // Composite FK to member(organization_id, user_id): B's user is no member of A.
    await expect(
      asA((tx) =>
        transitionAction(tx, {
          actionId: worldA.action.id,
          from: 'concept',
          to: 'approved',
          actor: asUser(B.userId),
        }),
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
  });
});

describe('links between tenants', () => {
  it('a card of A cannot be linked to an event or entity of B', async () => {
    await expect(
      asA((tx) => linkCard(tx, { cardId: worldA.card.id, eventIds: [worldB.event.id] })),
    ).rejects.toMatchObject(foreignKeyViolation);
    await expect(
      asA((tx) => linkCard(tx, { cardId: worldA.card.id, entityIds: [worldB.contact.id] })),
    ).rejects.toMatchObject(foreignKeyViolation);
  });

  it('a card of A cannot point to a connection or task of B', async () => {
    await expect(
      asA((tx) =>
        createCard(tx, {
          kind: 'connection_problem',
          title: 'Koppeling verlopen',
          payload: { reason: 'invalid_grant' },
          connectionId: worldB.connection.id,
          actor: agent,
        }),
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
    const { task } = await asB((tx) =>
      createTask(tx, { title: 'Bellen', createdBy: 'user', source: { sourceType: 'system' } }),
    );
    await expect(
      asA((tx) =>
        createCard(tx, {
          kind: 'task_due',
          title: 'Bellen',
          payload: {},
          taskId: task.id,
          actor: agent,
        }),
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
  });

  it('an action of A cannot belong to a card or run through a connection of B', async () => {
    await expect(
      asA((tx) =>
        tx.execute(
          sql`insert into actions (card_id, connection_id, type, proposed_input, input, idempotency_key)
              values (${worldB.card.id}, ${worldA.connection.id}, 'email.reply', '{}', '{}', 'x-1')`,
        ),
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
    await expect(
      asA((tx) =>
        tx.execute(
          sql`insert into actions (card_id, connection_id, type, proposed_input, input, idempotency_key)
              values (${worldA.card.id}, ${worldB.connection.id}, 'email.reply', '{}', '{}', 'x-2')`,
        ),
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
    // The repository does not even see B's connection.
    await expect(
      asA((tx) =>
        proposeAction(tx, {
          cardId: worldA.card.id,
          connectionId: worldB.connection.id,
          type: 'email.reply',
          input: replyInput,
          actor: agent,
        }),
      ),
    ).rejects.toThrow(/cannot execute/);
  });

  it('an external ref of A cannot point to a connection or entity of B', async () => {
    await expect(
      asA((tx) =>
        addEntityExternalRef(tx, {
          entityId: worldA.contact.id,
          connectionId: worldB.connection.id,
          objectType: 'contact',
          externalId: '999',
        }),
      ),
    ).rejects.toThrow(/not found/);
    await expect(
      asA((tx) =>
        addEntityExternalRef(tx, {
          entityId: worldB.contact.id,
          connectionId: worldA.connection.id,
          objectType: 'contact',
          externalId: '999',
        }),
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
  });

  it('events and tasks of A cannot reference connections, actions or cards of B', async () => {
    await expect(
      asA((tx) =>
        recordEvent(tx, {
          event: {
            source: 'gmail',
            externalId: 'cross-1',
            type: 'email.received',
            occurredAt: new Date(),
            connectionId: worldB.connection.id,
            payload: {},
          },
        }),
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
    await expect(
      asA((tx) =>
        recordEvent(tx, {
          event: {
            source: 'app',
            externalId: 'cross-2',
            type: 'action.executed',
            occurredAt: new Date(),
            causedByActionId: worldB.action.id,
            payload: { providerObjectId: 'draft-1' },
          },
        }),
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
    await expect(
      asA((tx) =>
        createTask(tx, {
          title: 'X',
          createdBy: 'ai',
          originCardId: worldB.card.id,
          source: { sourceType: 'action', sourceActionId: worldA.action.id },
        }),
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
    await expect(
      asA((tx) =>
        createTask(tx, {
          title: 'X',
          createdBy: 'ai',
          source: { sourceType: 'action', sourceActionId: worldB.action.id },
        }),
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
  });
});
