import type { ActionStatus, CardStatus, ConnectionStatus } from '@effectief/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestDatabases, type TestTenant } from '../test-support.ts';
import { type TenantTransaction, withTenant } from '../with-tenant.ts';
import { type Action, getAction, transitionAction } from './actions.ts';
import { listAuditLog } from './audit.ts';
import { type Card, transitionCard } from './cards.ts';
import { type Connection, transitionConnection } from './connections.ts';
import { rowsInStatus } from './status-fixtures.ts';
import { asUser, system } from './test-fixtures.ts';

// Concurrent transitions of the same row: the guarded UPDATE
// (… WHERE status = from) lets exactly one win; the others get
// `status_changed` and write no audit entry.

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

describe('concurrent transitions', () => {
  /**
   * Runs each step in its own transaction. All transactions are open before
   * any step starts, and each holds its row lock briefly after updating, so
   * the updates truly overlap.
   */
  async function race<T>(steps: ((tx: TenantTransaction) => Promise<T>)[]) {
    let arrived = 0;
    let release: () => void = () => {};
    const allOpen = new Promise<void>((resolve) => {
      release = resolve;
    });
    return Promise.allSettled(
      steps.map((step) =>
        inTenant(async (tx) => {
          await tx.execute(sql`select 1`);
          arrived += 1;
          if (arrived === steps.length) release();
          await allOpen;
          const result = await step(tx);
          await tx.execute(sql`select pg_sleep(0.05)`);
          return result;
        }),
      ),
    );
  }

  function expectOneWinner(results: PromiseSettledResult<unknown>[]) {
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const losers = results.filter((r) => r.status === 'rejected');
    expect(losers).toHaveLength(results.length - 1);
    for (const loser of losers) {
      expect(loser.reason).toMatchObject({ name: 'TransitionError', code: 'status_changed' });
    }
  }

  it('approve versus reject: one wins, one audit entry', async () => {
    const action = await actionIn('concept');
    const results = await race<Action>([
      (tx) =>
        transitionAction(tx, { actionId: action.id, from: 'concept', to: 'approved', actor: user }),
      (tx) =>
        transitionAction(tx, { actionId: action.id, from: 'concept', to: 'rejected', actor: user }),
    ]);
    expectOneWinner(results);
    const winner = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Action>;
    const stored = await inTenant((tx) => getAction(tx, action.id));
    expect(stored?.status).toBe(winner.value.status);
    const audit = await inTenant((tx) =>
      listAuditLog(tx, { objectType: 'actions', objectId: action.id }),
    );
    expect(audit.map((e) => e.action)).toEqual([
      'action.proposed',
      `action.${winner.value.status}`,
    ]);
  });

  it('the same approval three times at once: it is approved once', async () => {
    const action = await actionIn('concept');
    const approve = (tx: TenantTransaction) =>
      transitionAction(tx, { actionId: action.id, from: 'concept', to: 'approved', actor: user });
    expectOneWinner(await race([approve, approve, approve]));
    const audit = await inTenant((tx) =>
      listAuditLog(tx, { objectType: 'actions', objectId: action.id }),
    );
    expect(audit.filter((e) => e.action === 'action.approved')).toHaveLength(1);
  });

  it('two jobs claiming one approved action: exactly one owns it', async () => {
    const action = await actionIn('approved');
    const claim = (jobId: string) => (tx: TenantTransaction) =>
      transitionAction(tx, {
        actionId: action.id,
        from: 'approved',
        to: 'executing',
        jobId,
        actor: system,
      });
    const results = await race([claim('job-a'), claim('job-b')]);
    expectOneWinner(results);
    const stored = await inTenant((tx) => getAction(tx, action.id));
    expect(stored?.attempts).toBe(1);
    expect(['job-a', 'job-b']).toContain(stored?.executionJobId);
  });

  it('revoke versus expire of a connection', async () => {
    const connection = await connectionIn('active');
    const results = await race<Connection>([
      (tx) =>
        transitionConnection(tx, {
          connectionId: connection.id,
          from: 'active',
          to: 'revoked',
          reason: 'user_disconnected',
          actor: user,
        }),
      (tx) =>
        transitionConnection(tx, {
          connectionId: connection.id,
          from: 'active',
          to: 'expired',
          reason: 'invalid_grant',
          actor: system,
        }),
    ]);
    expectOneWinner(results);
    const audit = await inTenant((tx) =>
      listAuditLog(tx, { objectType: 'connections', objectId: connection.id }),
    );
    expect(audit).toHaveLength(2);
  });

  it('done versus dismissed of a card', async () => {
    const card = await cardIn('open');
    const results = await race<Card>([
      (tx) => transitionCard(tx, { cardId: card.id, from: 'open', to: 'done', actor: user }),
      (tx) => transitionCard(tx, { cardId: card.id, from: 'open', to: 'dismissed', actor: user }),
    ]);
    expectOneWinner(results);
    const audit = await inTenant((tx) =>
      listAuditLog(tx, { objectType: 'cards', objectId: card.id }),
    );
    expect(audit).toHaveLength(2);
  });
});
