import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTask, getTask } from '../memory/tasks.ts';
import { checkViolation, openTestDatabases, type TestTenant } from '../test-support.ts';
import { withTenant } from '../with-tenant.ts';
import { idempotencyKeyOf, listCardActions, proposeAction } from './actions.ts';
import { listAuditLog } from './audit.ts';
import { createCard, getCardLinks, transitionCard } from './cards.ts';
import { addEntityExternalRef, transitionConnection } from './connections.ts';
import {
  agent,
  asUser,
  createTestConnection,
  replyInput,
  seedFeed,
  system,
} from './test-fixtures.ts';

// Behaviour of the feed repository functions: idempotent proposals, card
// deduplication, provider checks and the links between cards and tasks.

const db = openTestDatabases();
let tenant: TestTenant;
let world: Awaited<ReturnType<typeof seedFeed>>;

const inTenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(db.app.db, tenant.tenantId, fn);

beforeAll(async () => {
  tenant = await db.createTenant();
  world = await inTenant((tx) => seedFeed(tx, tenant));
});
afterAll(() => db.close());

describe('proposeAction', () => {
  it('is idempotent per card, type and ordinal', async () => {
    const again = await inTenant((tx) =>
      proposeAction(tx, {
        cardId: world.card.id,
        connectionId: world.connection.id,
        type: 'email.reply',
        input: { ...replyInput, bodyText: 'Een ander voorstel' },
        actor: agent,
      }),
    );
    expect(again).toMatchObject({ created: false, action: { id: world.action.id } });
    expect(world.action.idempotencyKey).toBe(idempotencyKeyOf(world.card.id, 'email.reply', 1));
    expect(world.action.input).toEqual(replyInput);

    const second = await inTenant((tx) =>
      proposeAction(tx, {
        cardId: world.card.id,
        connectionId: world.connection.id,
        type: 'email.reply',
        ordinal: 2,
        input: replyInput,
        actor: agent,
      }),
    );
    expect(second.created).toBe(true);
    expect(await inTenant((tx) => listCardActions(tx, world.card.id))).toHaveLength(2);

    const audit = await inTenant((tx) =>
      listAuditLog(tx, { objectType: 'actions', objectId: world.action.id }),
    );
    expect(audit.map((e) => e.action)).toEqual(['action.proposed']);
  });

  it('needs an active connection of a provider that can execute the type', async () => {
    const moneybird = await inTenant((tx) => createTestConnection(tx, tenant, 'moneybird'));
    await expect(
      inTenant((tx) =>
        proposeAction(tx, {
          cardId: world.card.id,
          connectionId: moneybird.id,
          type: 'email.reply',
          input: replyInput,
          actor: agent,
        }),
      ),
    ).rejects.toThrow(/cannot execute/);

    const expired = await inTenant(async (tx) => {
      const gmail = await createTestConnection(tx, tenant);
      return transitionConnection(tx, {
        connectionId: gmail.id,
        from: 'active',
        to: 'expired',
        reason: 'invalid_grant',
        actor: system,
      });
    });
    await expect(
      inTenant((tx) =>
        proposeAction(tx, {
          cardId: world.card.id,
          connectionId: expired.id,
          type: 'email.reply',
          ordinal: 3,
          input: replyInput,
          actor: agent,
        }),
      ),
    ).rejects.toThrow(/cannot execute/);
  });

  it('validates the input against the schema of the type', async () => {
    await expect(
      inTenant((tx) =>
        proposeAction(tx, {
          cardId: world.card.id,
          connectionId: world.connection.id,
          type: 'email.reply',
          ordinal: 4,
          // @ts-expect-error: a reply needs recipients, subject and body
          input: { bodyText: 'Hallo' },
          actor: agent,
        }),
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });
  });
});

describe('cards', () => {
  it('one open card per dedupe key: a repeat adds links to the existing card', async () => {
    const dedupeKey = 'thread:dedupe-1';
    const first = await inTenant((tx) =>
      createCard(tx, {
        kind: 'email_reply',
        title: 'Vraag van Jan',
        payload: {},
        dedupeKey,
        eventIds: [world.event.id],
        actor: agent,
      }),
    );
    const second = await inTenant((tx) =>
      createCard(tx, {
        kind: 'email_reply',
        title: 'Nieuwe mail van Jan',
        payload: {},
        dedupeKey,
        entityIds: [world.contact.id],
        actor: agent,
      }),
    );
    expect(second).toMatchObject({ created: false, card: { id: first.card.id } });
    expect(await inTenant((tx) => getCardLinks(tx, first.card.id))).toEqual({
      eventIds: [world.event.id],
      entityIds: [world.contact.id],
    });
    const audit = await inTenant((tx) =>
      listAuditLog(tx, { objectType: 'cards', objectId: first.card.id }),
    );
    expect(audit.map((e) => e.action)).toEqual(['card.created']);

    // Once resolved, the same thread can get a new card.
    await inTenant((tx) =>
      transitionCard(tx, { cardId: first.card.id, from: 'open', to: 'done', actor: system }),
    );
    const third = await inTenant((tx) =>
      createCard(tx, {
        kind: 'email_reply',
        title: 'Weer Jan',
        payload: {},
        dedupeKey,
        actor: agent,
      }),
    );
    expect(third.created).toBe(true);
    expect(third.card.id).not.toBe(first.card.id);
  });

  it('a task_due card belongs to a task, a task can come from a card', async () => {
    const { task } = await inTenant((tx) =>
      createTask(tx, {
        title: 'Jan terugbellen',
        createdBy: 'ai',
        originCardId: world.card.id,
        source: { sourceType: 'action', sourceActionId: world.action.id },
      }),
    );
    expect(task).toMatchObject({ originCardId: world.card.id, sourceActionId: world.action.id });

    const { card } = await inTenant((tx) =>
      createCard(tx, {
        kind: 'task_due',
        title: 'Jan terugbellen',
        payload: {},
        taskId: task.id,
        actor: system,
      }),
    );
    expect(card.taskId).toBe(task.id);

    await expect(
      inTenant((tx) =>
        tx.execute(sql`insert into cards (kind, title, payload) values ('task_due', 'X', '{}')`),
      ),
    ).rejects.toMatchObject(checkViolation);
  });

  it('deleting a card removes its actions and links, and clears the origin of tasks', async () => {
    const { card, task } = await inTenant(async (tx) => {
      const { card } = await createCard(tx, {
        kind: 'email_reply',
        title: 'Weg',
        payload: {},
        eventIds: [world.event.id],
        actor: agent,
      });
      await proposeAction(tx, {
        cardId: card.id,
        connectionId: world.connection.id,
        type: 'email.reply',
        input: replyInput,
        actor: agent,
      });
      const { task } = await createTask(tx, {
        title: 'X',
        createdBy: 'user',
        originCardId: card.id,
        source: { sourceType: 'user', sourceUserId: tenant.userId },
      });
      return { card, task };
    });
    await inTenant((tx) => tx.execute(sql`delete from cards where id = ${card.id}`));
    expect(await inTenant((tx) => listCardActions(tx, card.id))).toEqual([]);
    expect(await inTenant((tx) => getCardLinks(tx, card.id))).toEqual({
      eventIds: [],
      entityIds: [],
    });
    expect((await inTenant((tx) => getTask(tx, task.id)))?.originCardId).toBeNull();
  });
});

describe('connections', () => {
  it('external refs are idempotent and take the provider from the connection', async () => {
    const input = {
      entityId: world.contact.id,
      connectionId: world.connection.id,
      objectType: 'contact',
      externalId: 'c-1',
    };
    const first = await inTenant((tx) => addEntityExternalRef(tx, input));
    const again = await inTenant((tx) => addEntityExternalRef(tx, input));
    expect(first).toMatchObject({ created: true, ref: { provider: 'gmail' } });
    expect(again).toMatchObject({ created: false, ref: { id: first.ref.id } });
  });

  it('one active connection per provider account', async () => {
    const connection = await inTenant((tx) => createTestConnection(tx, tenant));
    await expect(
      inTenant((tx) =>
        tx.execute(
          sql`insert into connections (provider, nango_integration_id, nango_connection_id, external_account_id)
              values ('gmail', 'google-mail', 'conn-dup', ${connection.externalAccountId})`,
        ),
      ),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23505' }) });
  });

  it('a purged connection keeps no account label', async () => {
    const connection = await inTenant((tx) => createTestConnection(tx, tenant));
    await expect(
      inTenant(async (tx) => {
        await transitionConnection(tx, {
          connectionId: connection.id,
          from: 'active',
          to: 'revoked',
          reason: 'user_disconnected',
          actor: asUser(tenant.userId),
        });
        await tx.execute(sql`update connections set status = 'purged' where id = ${connection.id}`);
      }),
    ).rejects.toMatchObject(checkViolation);
  });
});
