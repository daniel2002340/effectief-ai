import type { ActionStatus } from '@effectief/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTestDatabases, type TestTenant } from '../test-support.ts';
import { type TenantTransaction, withTenant } from '../with-tenant.ts';
import { transitionAction } from './actions.ts';
import { listAuditLog } from './audit.ts';
import { rowsInStatus } from './status-fixtures.ts';
import { agent, asUser, replyInput, system } from './test-fixtures.ts';

// The action pipeline through transitionAction(): approval by a user only,
// input that changes only in concept, and a provider object that is reused
// when an executed action is edited and executed again.

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
const actionIn = (status: ActionStatus) => rows.actionIn(status);
const integrityViolation = { cause: expect.objectContaining({ code: '23000' }) };

describe('actions', () => {
  it('propose, approve with an edit, execute; one audit entry per step', async () => {
    const action = await actionIn('concept');
    expect(action).toMatchObject({
      status: 'concept',
      proposedInput: replyInput,
      input: replyInput,
    });

    const edited = { ...replyInput, bodyText: 'Beste Jan, hierbij de offerte. Groet, Piet' };
    const approved = await inTenant((tx) =>
      transitionAction(tx, {
        actionId: action.id,
        from: 'concept',
        to: 'approved',
        input: edited,
        actor: user,
      }),
    );
    expect(approved).toMatchObject({
      status: 'approved',
      input: edited,
      proposedInput: replyInput,
      approvedByUserId: tenant.userId,
    });

    const executed = await inTenant((tx) =>
      transitionAction(tx, {
        actionId: action.id,
        from: 'approved',
        to: 'executed',
        providerObjectId: 'draft-42',
        result: { providerThreadId: 'thread-1' },
        actor: system,
      }),
    );
    expect(executed).toMatchObject({
      status: 'executed',
      providerObjectId: 'draft-42',
      attempts: 1,
    });

    const audit = await inTenant((tx) =>
      listAuditLog(tx, { objectType: 'actions', objectId: action.id }),
    );
    expect(audit.map((e) => [e.action, e.actorType])).toEqual([
      ['action.proposed', 'agent'],
      ['action.approved', 'user'],
      ['action.executed', 'system'],
    ]);
    expect(audit[2]?.metadata).toEqual({
      type: 'email.reply',
      cardId: action.cardId,
      providerObjectId: 'draft-42',
      attempts: 1,
    });
  });

  it('only a user can approve or reject', async () => {
    const action = await actionIn('concept');
    for (const actor of [agent, system]) {
      await expect(
        inTenant((tx) =>
          // @ts-expect-error: approving needs a user actor
          transitionAction(tx, { actionId: action.id, from: 'concept', to: 'approved', actor }),
        ),
      ).rejects.toMatchObject({ name: 'ZodError' });
      await expect(
        inTenant((tx) =>
          // @ts-expect-error: rejecting needs a user actor
          transitionAction(tx, { actionId: action.id, from: 'concept', to: 'rejected', actor }),
        ),
      ).rejects.toMatchObject({ name: 'ZodError' });
    }
    // Without approved_at the database refuses an approved action as well.
    await expect(
      inTenant((tx) =>
        tx.execute(sql`update actions set status = 'approved' where id = ${action.id}`),
      ),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23514' }) });
  });

  it('a failed action is retried after a new approval; editing after execution reuses the provider object', async () => {
    const failed = await actionIn('failed');
    expect(failed).toMatchObject({ lastErrorCode: 'provider_unavailable', attempts: 1 });
    await expect(
      inTenant((tx) =>
        transitionAction(tx, {
          actionId: failed.id,
          from: 'failed',
          to: 'approved',
          input: replyInput,
          actor: user,
        }),
      ),
    ).rejects.toThrow(/only change while it is a concept/);

    await inTenant(async (tx) => {
      await transitionAction(tx, {
        actionId: failed.id,
        from: 'failed',
        to: 'approved',
        actor: user,
      });
      await transitionAction(tx, {
        actionId: failed.id,
        from: 'approved',
        to: 'executed',
        providerObjectId: 'draft-7',
        result: {},
        actor: system,
      });
      const reopened = await transitionAction(tx, {
        actionId: failed.id,
        from: 'executed',
        to: 'concept',
        actor: user,
      });
      expect(reopened).toMatchObject({
        status: 'concept',
        providerObjectId: 'draft-7',
        approvedByUserId: null,
        approvedAt: null,
      });
      await transitionAction(tx, {
        actionId: failed.id,
        from: 'concept',
        to: 'approved',
        input: { ...replyInput, subject: 'Re: Offerte (aangepast)' },
        actor: user,
      });
    });

    // A repeat updates the same provider object; a different one is refused.
    await expect(
      inTenant((tx) =>
        transitionAction(tx, {
          actionId: failed.id,
          from: 'approved',
          to: 'executed',
          providerObjectId: 'draft-8',
          result: {},
          actor: system,
        }),
      ),
    ).rejects.toMatchObject(integrityViolation);
    const executed = await inTenant((tx) =>
      transitionAction(tx, {
        actionId: failed.id,
        from: 'approved',
        to: 'executed',
        providerObjectId: 'draft-7',
        result: {},
        actor: system,
      }),
    );
    expect(executed).toMatchObject({ providerObjectId: 'draft-7', attempts: 3 });
  });

  it('input only changes in concept and proposed_input never, except by retention', async () => {
    const approved = await actionIn('approved');
    await expect(
      inTenant((tx) =>
        tx.execute(sql`update actions set input = '{"x":1}' where id = ${approved.id}`),
      ),
    ).rejects.toMatchObject(integrityViolation);

    const concept = await actionIn('concept');
    await expect(
      inTenant((tx) =>
        tx.execute(sql`update actions set proposed_input = '{"x":1}' where id = ${concept.id}`),
      ),
    ).rejects.toMatchObject(integrityViolation);
    await expect(
      inTenant((tx) => tx.execute(sql`update actions set input = null where id = ${concept.id}`)),
    ).rejects.toThrow();

    const executed = await actionIn('executed');
    const purged = await inTenant((tx) =>
      tx.execute(
        sql`update actions set proposed_input = null, input = null, input_purged_at = now() where id = ${executed.id}`,
      ),
    );
    expect(purged.rowCount).toBe(1);
  });

  it('input and result are validated per action type', async () => {
    const concept = await actionIn('concept');
    await expect(
      inTenant((tx) =>
        transitionAction(tx, {
          actionId: concept.id,
          from: 'concept',
          to: 'approved',
          input: { providerInvoiceId: 'inv-1' },
          actor: user,
        }),
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });

    const approved = await actionIn('approved');
    await expect(
      inTenant((tx) =>
        transitionAction(tx, {
          actionId: approved.id,
          from: 'approved',
          to: 'executed',
          providerObjectId: 'draft-1',
          result: { body: 'Beste Jan' },
          actor: system,
        }),
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });
  });
});
