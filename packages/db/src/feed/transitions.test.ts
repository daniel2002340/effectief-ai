import {
  type ActionStatus,
  actionStatuses,
  actionTransitions,
  type CardStatus,
  type ConnectionStatus,
  cardStatuses,
  cardTransitions,
  connectionStatuses,
  connectionTransitions,
  isAllowedTransition,
  transitionPairs,
} from '@effectief/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestDatabases, type TestTenant } from '../test-support.ts';
import { type TenantTransaction, withTenant } from '../with-tenant.ts';
import { getAction, transitionAction } from './actions.ts';
import { listAuditLog } from './audit.ts';
import { getCard, transitionCard } from './cards.ts';
import { getConnection, transitionConnection } from './connections.ts';
import { rowsInStatus } from './status-fixtures.ts';
import { asUser, system } from './test-fixtures.ts';

// Status changes go through one function per table, which refuses transitions
// outside the lists in packages/shared and applies atomically
// (UPDATE … WHERE status = from). A trigger with the same pairs refuses them
// in the database too. Every change writes exactly one audit entry.

const db = openTestDatabases();
let tenant: TestTenant;
let user: ReturnType<typeof asUser>;

let rows: ReturnType<typeof rowsInStatus>;

beforeAll(async () => {
  tenant = await db.createTenant();
  user = asUser(tenant.userId);
  rows = rowsInStatus(inTenant, tenant);
});
afterAll(() => db.close());

const inTenant = <T>(fn: (tx: TenantTransaction) => Promise<T>) =>
  withTenant(db.app.db, tenant.tenantId, fn);
const connectionIn = (status: ConnectionStatus) => rows.connectionIn(status);
const cardIn = (status: CardStatus) => rows.cardIn(status);
const actionIn = (status: ActionStatus) => rows.actionIn(status);

const integrityViolation = { cause: expect.objectContaining({ code: '23000' }) };

/** Every (from, to) pair with from ≠ to that is not in the list. */
function forbiddenPairs<S extends string>(
  statuses: readonly S[],
  transitions: { readonly [From in S]: readonly S[] },
) {
  return statuses.flatMap((from) =>
    statuses
      .filter((to) => to !== from && !isAllowedTransition(transitions, from, to))
      .map((to) => [from, to] as const),
  );
}

describe('transition lists', () => {
  it('match the arguments of the database triggers', async () => {
    const { rows } = await db.app.db.execute<{ table_name: string; args: string }>(sql`
      select c.relname as table_name, encode(t.tgargs, 'escape') as args
        from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where t.tgname in ('connections_status_guard', 'cards_status_guard', 'actions_status_guard')
    `);
    const actual = Object.fromEntries(
      rows.map((row) => [row.table_name, row.args.split('\\000').filter(Boolean).sort()]),
    );
    expect(actual).toEqual({
      connections: transitionPairs(connectionTransitions).sort(),
      cards: transitionPairs(cardTransitions).sort(),
      actions: transitionPairs(actionTransitions).sort(),
    });
  });
});

describe('invalid transitions are refused', () => {
  it.each(forbiddenPairs(connectionStatuses, connectionTransitions))(
    'connections: %s → %s',
    async (from, to) => {
      const row = await connectionIn(from);
      await expect(
        inTenant((tx) =>
          transitionConnection(tx, {
            connectionId: row.id,
            from,
            to,
            reason: 'reauthorized',
            actor: user,
          }),
        ),
      ).rejects.toMatchObject({ name: 'TransitionError', code: 'invalid_transition' });
      await expect(
        inTenant((tx) =>
          tx.execute(sql`update connections set status = ${to} where id = ${row.id}`),
        ),
      ).rejects.toMatchObject(integrityViolation);
      expect((await inTenant((tx) => getConnection(tx, row.id)))?.status).toBe(from);
    },
  );

  it.each(forbiddenPairs(cardStatuses, cardTransitions))('cards: %s → %s', async (from, to) => {
    const row = await cardIn(from);
    const input =
      to === 'snoozed' ? ({ to, snoozedUntil: new Date() } as const) : ({ to } as const);
    await expect(
      inTenant((tx) => transitionCard(tx, { cardId: row.id, from, ...input, actor: user })),
    ).rejects.toMatchObject({ name: 'TransitionError', code: 'invalid_transition' });
    await expect(
      inTenant((tx) => tx.execute(sql`update cards set status = ${to} where id = ${row.id}`)),
    ).rejects.toMatchObject(integrityViolation);
    expect((await inTenant((tx) => getCard(tx, row.id)))?.status).toBe(from);
  });

  it.each(forbiddenPairs(actionStatuses, actionTransitions))(
    'actions: %s → %s',
    async (from, to) => {
      const row = await actionIn(from);
      const input = {
        approved: { to: 'approved', actor: user },
        rejected: { to: 'rejected', actor: user },
        executed: { to: 'executed', providerObjectId: 'x', result: {}, actor: system },
        failed: { to: 'failed', errorCode: 'x', actor: system },
        concept: { to: 'concept', actor: user },
      } as const;
      await expect(
        inTenant((tx) => transitionAction(tx, { actionId: row.id, from, ...input[to] })),
      ).rejects.toMatchObject({ name: 'TransitionError', code: 'invalid_transition' });
      await expect(
        inTenant((tx) => tx.execute(sql`update actions set status = ${to} where id = ${row.id}`)),
      ).rejects.toMatchObject(integrityViolation);
      expect((await inTenant((tx) => getAction(tx, row.id)))?.status).toBe(from);
    },
  );

  it('a stale `from` is refused with status_changed and changes nothing', async () => {
    const row = await connectionIn('expired');
    await expect(
      inTenant((tx) =>
        transitionConnection(tx, {
          connectionId: row.id,
          from: 'active',
          to: 'revoked',
          reason: 'user_disconnected',
          actor: user,
        }),
      ),
    ).rejects.toMatchObject({ code: 'status_changed', current: 'expired' });
    const audit = await inTenant((tx) =>
      listAuditLog(tx, { objectType: 'connections', objectId: row.id }),
    );
    expect(audit.map((entry) => entry.action)).toEqual([
      'connection.created',
      'connection.expired',
    ]);
  });

  it('new rows must start in the first status, also with raw SQL', async () => {
    const card = await cardIn('open');
    const connection = await connectionIn('active');
    await expect(
      inTenant((tx) =>
        tx.execute(
          sql`insert into actions (card_id, connection_id, type, status, proposed_input, input, idempotency_key, approved_at)
              values (${card.id}, ${connection.id}, 'email.reply', 'approved', '{}', '{}', 'raw-approved', now())`,
        ),
      ),
    ).rejects.toMatchObject(integrityViolation);
    await expect(
      inTenant((tx) =>
        tx.execute(
          sql`insert into cards (kind, title, payload, status, resolved_at) values ('insight', 'X', '{}', 'done', now())`,
        ),
      ),
    ).rejects.toMatchObject(integrityViolation);
    await expect(
      inTenant((tx) =>
        tx.execute(
          sql`insert into connections (provider, nango_integration_id, nango_connection_id, status)
              values ('gmail', 'google-mail', 'raw-revoked', 'revoked')`,
        ),
      ),
    ).rejects.toMatchObject(integrityViolation);
  });

  it('a new action carries no approval or provider object, also with raw SQL', async () => {
    const card = await cardIn('open');
    const connection = await connectionIn('active');
    await expect(
      inTenant((tx) =>
        tx.execute(
          sql`insert into actions (card_id, connection_id, type, proposed_input, input, idempotency_key, provider_object_id)
              values (${card.id}, ${connection.id}, 'email.reply', '{}', '{}', 'raw-provider', 'draft-1')`,
        ),
      ),
    ).rejects.toMatchObject(integrityViolation);
  });
});

describe('connections', () => {
  it('expire, reactivate, revoke and purge, each with one audit entry', async () => {
    const row = await connectionIn('active');
    const steps: [
      ConnectionStatus,
      ConnectionStatus,
      'invalid_grant' | 'reauthorized' | 'user_disconnected' | 'data_purged',
    ][] = [
      ['active', 'expired', 'invalid_grant'],
      ['expired', 'active', 'reauthorized'],
      ['active', 'revoked', 'user_disconnected'],
      ['revoked', 'purged', 'data_purged'],
    ];
    const final = await inTenant(async (tx) => {
      let current = row;
      for (const [from, to, reason] of steps) {
        current = await transitionConnection(tx, {
          connectionId: row.id,
          from,
          to,
          reason,
          actor: system,
        });
      }
      return current;
    });
    expect(final).toMatchObject({
      status: 'purged',
      statusReason: 'data_purged',
      accountLabel: null,
    });

    const audit = await inTenant((tx) =>
      listAuditLog(tx, { objectType: 'connections', objectId: row.id }),
    );
    expect(audit.map((e) => [e.action, e.fromStatus, e.toStatus, e.actorType])).toEqual([
      ['connection.created', null, 'active', 'user'],
      ['connection.expired', 'active', 'expired', 'system'],
      ['connection.reactivated', 'expired', 'active', 'system'],
      ['connection.revoked', 'active', 'revoked', 'system'],
      ['connection.purged', 'revoked', 'purged', 'system'],
    ]);
    expect(audit[1]?.metadata).toEqual({ provider: 'gmail', reason: 'invalid_grant' });
  });
});

describe('cards', () => {
  it('snooze, reopen and resolve set the matching fields', async () => {
    const row = await cardIn('open');
    const until = new Date(Date.now() + 3_600_000);
    const snoozed = await inTenant((tx) =>
      transitionCard(tx, {
        cardId: row.id,
        from: 'open',
        to: 'snoozed',
        snoozedUntil: until,
        actor: user,
      }),
    );
    expect(snoozed.snoozedUntil).toEqual(until);
    const reopened = await inTenant((tx) =>
      transitionCard(tx, { cardId: row.id, from: 'snoozed', to: 'open', actor: system }),
    );
    expect(reopened.snoozedUntil).toBeNull();
    const done = await inTenant((tx) =>
      transitionCard(tx, { cardId: row.id, from: 'open', to: 'done', actor: user }),
    );
    expect(done).toMatchObject({ status: 'done', resolvedByUserId: tenant.userId });
    expect(done.resolvedAt).toBeInstanceOf(Date);

    const audit = await inTenant((tx) =>
      listAuditLog(tx, { objectType: 'cards', objectId: row.id }),
    );
    expect(audit.map((e) => e.action)).toEqual([
      'card.created',
      'card.snoozed',
      'card.reopened',
      'card.done',
    ]);
  });
});
