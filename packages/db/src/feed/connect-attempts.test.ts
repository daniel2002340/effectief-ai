import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeExpiredBatch } from '../lifecycle/retention.ts';
import { auditLog, cards, connectAttempts } from '../schema/index.ts';
import { checkViolation, openTestDatabases, type TestTenant } from '../test-support.ts';
import { type TenantTransaction, withTenant } from '../with-tenant.ts';
import { getCard } from './cards.ts';
import {
  consumeConnectAttempt,
  createConnectAttempt,
  failConnectAttempt,
  getConnectAttempt,
  isOpenConnectAttempt,
  listOpenConnectAttempts,
  lockConnectAttempt,
  resolveConnectAttempt,
} from './connect-attempts.ts';
import {
  expireConnection,
  findLiveAccountConnection,
  getConnectionByNangoId,
  reactivateConnection,
} from './connection-status.ts';
import { getConnection } from './connections.ts';
import { createTestConnection } from './test-fixtures.ts';
import { recordWebhookDelivery } from './webhooks.ts';

// connect_attempts and resolve_connect_attempt() (docs/integrations.md §2.2):
// a nonce only finds its own tenant's attempt, an attempt is consumed once,
// and tenant B can never see or change tenant A's attempts.

const db = openTestDatabases();
let A: TestTenant;
let B: TestTenant;
const DAY_MS = 24 * 60 * 60 * 1000;

const asA = <T>(fn: (tx: TenantTransaction) => Promise<T>) => withTenant(db.app.db, A.tenantId, fn);
const asB = <T>(fn: (tx: TenantTransaction) => Promise<T>) => withTenant(db.app.db, B.tenantId, fn);

const start = (tenant: TestTenant) => (tx: TenantTransaction) =>
  createConnectAttempt(tx, {
    provider: 'gmail',
    nangoIntegrationId: 'gmail',
    createdByUserId: tenant.userId,
  });

beforeAll(async () => {
  A = await db.createTenant();
  B = await db.createTenant();
});
afterAll(() => db.close());

describe('createConnectAttempt', () => {
  it('starts an open attempt with a fresh 256-bit nonce and a 30-minute expiry', async () => {
    const first = await asA(start(A));
    const second = await asA(start(A));
    expect(first.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(second.nonce).not.toBe(first.nonce);
    expect(first).toMatchObject({
      tenantId: A.tenantId,
      createdByUserId: A.userId,
      consumedAt: null,
    });
    const minutes = (first.expiresAt.getTime() - first.createdAt.getTime()) / 60_000;
    expect(minutes).toBeCloseTo(30, 0);
    expect(isOpenConnectAttempt(first)).toBe(true);
    expect(isOpenConnectAttempt(first, new Date(first.createdAt.getTime() + DAY_MS + 1))).toBe(
      false,
    );
  });

  it('refuses a creator who is not a member of the tenant', async () => {
    await expect(
      asA((tx) =>
        createConnectAttempt(tx, {
          provider: 'gmail',
          nangoIntegrationId: 'gmail',
          createdByUserId: B.userId,
        }),
      ),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23503' }) });
  });
});

describe('resolve_connect_attempt()', () => {
  it('finds the tenant of its own nonce only', async () => {
    const a = await asA(start(A));
    const b = await asB(start(B));
    expect(await resolveConnectAttempt(db.app.db, a.nonce)).toEqual({
      tenantId: A.tenantId,
      attemptId: a.id,
    });
    expect(await resolveConnectAttempt(db.app.db, b.nonce)).toEqual({
      tenantId: B.tenantId,
      attemptId: b.id,
    });
  });

  it('finds nothing for an unknown nonce or one that is not a nonce', async () => {
    expect(await resolveConnectAttempt(db.app.db, 'f'.repeat(64))).toBeUndefined();
    expect(await resolveConnectAttempt(db.app.db, "' or 1=1 --")).toBeUndefined();
    expect(await resolveConnectAttempt(db.app.db, '')).toBeUndefined();
  });

  it('only app_runtime may execute it', async () => {
    await expect(
      db.authPool.query(`select * from public.resolve_connect_attempt('${'a'.repeat(64)}')`),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('consuming', () => {
  it('consumes an attempt once', async () => {
    const attempt = await asA(start(A));
    const connection = await asA((tx) => createTestConnection(tx, A));
    const input = {
      attemptId: attempt.id,
      connectionId: connection.id,
      nangoConnectionId: connection.nangoConnectionId,
    };
    expect(await asA((tx) => consumeConnectAttempt(tx, input))).toBe(true);
    expect(await asA((tx) => consumeConnectAttempt(tx, input))).toBe(false);
    expect(
      await asA((tx) => failConnectAttempt(tx, { attemptId: attempt.id, failureCode: 'rejected' })),
    ).toBe(false);
    const after = await asA((tx) => getConnectAttempt(tx, attempt.id));
    expect(after).toMatchObject({ connectionId: connection.id, failureCode: null });
    expect(after?.consumedAt).toBeInstanceOf(Date);
  });

  it('closes a failed attempt with a code and an audit entry without personal data', async () => {
    const attempt = await asA(start(A));
    expect(
      await asA((tx) =>
        failConnectAttempt(tx, {
          attemptId: attempt.id,
          failureCode: 'duplicate_account',
          nangoConnectionId: 'nango-1',
        }),
      ),
    ).toBe(true);
    const audit = await asA((tx) =>
      tx.select().from(auditLog).where(eq(auditLog.objectId, attempt.id)),
    );
    expect(audit).toMatchObject([
      {
        action: 'connect_attempt.rejected',
        objectType: 'connect_attempts',
        metadata: { provider: 'gmail', failureCode: 'duplicate_account' },
      },
    ]);
    expect(await asA((tx) => getConnectAttempt(tx, attempt.id))).toMatchObject({
      failureCode: 'duplicate_account',
      nangoConnectionId: 'nango-1',
    });
  });

  it('refuses an outcome without consumed_at, or two outcomes', async () => {
    const attempt = await asA(start(A));
    await expect(
      asA((tx) =>
        tx
          .update(connectAttempts)
          .set({ failureCode: 'rejected' })
          .where(eq(connectAttempts.id, attempt.id)),
      ),
    ).rejects.toMatchObject(checkViolation);
  });

  it('lists open attempts in a window, oldest first, for the sweep', async () => {
    const attempt = await asA(start(A));
    const open = await asA((tx) =>
      listOpenConnectAttempts(tx, { createdBefore: new Date(Date.now() + 1000) }),
    );
    expect(open.map((row) => row.id)).toContain(attempt.id);
    const none = await asA((tx) =>
      listOpenConnectAttempts(tx, { createdBefore: new Date(Date.now() - DAY_MS) }),
    );
    expect(none.map((row) => row.id)).not.toContain(attempt.id);
  });
});

describe('tenant isolation', () => {
  it('B cannot read, lock, consume, fail or delete an attempt of A', async () => {
    const attempt = await asA(start(A));
    const connectionB = await asB((tx) => createTestConnection(tx, B));
    expect(await asB((tx) => getConnectAttempt(tx, attempt.id))).toBeUndefined();
    expect(await asB((tx) => lockConnectAttempt(tx, attempt.id))).toBeUndefined();
    const raw = await asB((tx) =>
      tx.execute(sql`select nonce from connect_attempts where id = ${attempt.id}`),
    );
    expect(raw.rows).toHaveLength(0);
    expect(
      await asB((tx) =>
        consumeConnectAttempt(tx, {
          attemptId: attempt.id,
          connectionId: connectionB.id,
          nangoConnectionId: connectionB.nangoConnectionId,
        }),
      ),
    ).toBe(false);
    expect(
      await asB((tx) => failConnectAttempt(tx, { attemptId: attempt.id, failureCode: 'rejected' })),
    ).toBe(false);
    const deleted = await asB((tx) =>
      tx.delete(connectAttempts).where(eq(connectAttempts.id, attempt.id)).returning(),
    );
    expect(deleted).toHaveLength(0);
    const after = await asA((tx) => getConnectAttempt(tx, attempt.id));
    expect(after && isOpenConnectAttempt(after)).toBe(true);
  });

  it('A cannot point its attempt at a connection of B', async () => {
    const attempt = await asA(start(A));
    const connectionB = await asB((tx) => createTestConnection(tx, B));
    await expect(
      asA((tx) =>
        consumeConnectAttempt(tx, {
          attemptId: attempt.id,
          connectionId: connectionB.id,
          nangoConnectionId: connectionB.nangoConnectionId,
        }),
      ),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23503' }) });
  });

  it('B cannot store a creation delivery for an attempt of A', async () => {
    const attempt = await asA(start(A));
    await expect(
      asB((tx) =>
        recordWebhookDelivery(tx, {
          connectAttemptId: attempt.id,
          source: 'nango',
          deliveryId: 'e'.repeat(64),
          payload: {
            type: 'auth',
            operation: 'creation',
            connectionId: 'n1',
            providerConfigKey: 'gmail',
            provider: 'google-mail',
            environment: 'staging',
            success: true,
          },
        }),
      ),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23503' }) });
  });

  it('a delivery points at exactly one of connection and attempt', async () => {
    const attempt = await asA(start(A));
    const connection = await asA((tx) => createTestConnection(tx, A));
    await expect(
      asA((tx) =>
        recordWebhookDelivery(tx, {
          connectionId: connection.id,
          connectAttemptId: attempt.id,
          source: 'nango',
          deliveryId: 'f'.repeat(64),
          payload: {
            type: 'auth',
            operation: 'creation',
            connectionId: 'n1',
            providerConfigKey: 'gmail',
            provider: 'google-mail',
            environment: 'staging',
            success: true,
          },
        }),
      ),
    ).rejects.toThrow(/Exactly one/);
  });
});

describe('retention', () => {
  it('deletes attempts older than 30 days, open or not', async () => {
    const attempt = await asA(start(A));
    await asA((tx) =>
      purgeExpiredBatch(tx, { step: 'connect_attempts', now: new Date(Date.now() + 29 * DAY_MS) }),
    );
    expect(await asA((tx) => getConnectAttempt(tx, attempt.id))).toBeDefined();
    await asA((tx) =>
      purgeExpiredBatch(tx, { step: 'connect_attempts', now: new Date(Date.now() + 31 * DAY_MS) }),
    );
    expect(await asA((tx) => getConnectAttempt(tx, attempt.id))).toBeUndefined();
  });
});

describe('connection status', () => {
  const problemCards = (connectionId: string) =>
    asA((tx) => tx.select().from(cards).where(eq(cards.connectionId, connectionId)));

  it('expires an active connection with one problem card, and reactivates it', async () => {
    const connection = await asA((tx) => createTestConnection(tx, A));
    await asA((tx) =>
      expireConnection(tx, { connectionId: connection.id, reason: 'invalid_grant' }),
    );
    await asA((tx) =>
      expireConnection(tx, { connectionId: connection.id, reason: 'invalid_grant' }),
    );
    expect(await asA((tx) => getConnection(tx, connection.id))).toMatchObject({
      status: 'expired',
      statusReason: 'invalid_grant',
    });
    const [card] = await problemCards(connection.id);
    expect(await problemCards(connection.id)).toHaveLength(1);
    expect(card).toMatchObject({
      kind: 'connection_problem',
      status: 'open',
      payload: { reason: 'invalid_grant' },
    });

    await asA((tx) =>
      reactivateConnection(tx, { connectionId: connection.id, reason: 'auth_recovered' }),
    );
    expect(await asA((tx) => getConnection(tx, connection.id))).toMatchObject({
      status: 'active',
      statusReason: 'auth_recovered',
    });
    expect(await asA((tx) => getCard(tx, card?.id ?? ''))).toMatchObject({ status: 'done' });
  });

  it('records a re-authorization of an active connection without a status change', async () => {
    const connection = await asA((tx) => createTestConnection(tx, A));
    await asA((tx) =>
      reactivateConnection(tx, { connectionId: connection.id, reason: 'reauthorized' }),
    );
    expect(await asA((tx) => getConnection(tx, connection.id))).toMatchObject({ status: 'active' });
    const audit = await asA((tx) =>
      tx.select().from(auditLog).where(eq(auditLog.objectId, connection.id)),
    );
    expect(audit.map((entry) => entry.action)).toContain('connection.reauthorized');
  });

  it('leaves revoked connections alone', async () => {
    const connection = await asA((tx) => createTestConnection(tx, A));
    await asA((tx) =>
      tx.execute(
        sql`update connections set status = 'revoked', status_reason = 'user_disconnected' where id = ${connection.id}`,
      ),
    );
    await asA((tx) =>
      expireConnection(tx, { connectionId: connection.id, reason: 'invalid_grant' }),
    );
    await asA((tx) =>
      reactivateConnection(tx, { connectionId: connection.id, reason: 'auth_recovered' }),
    );
    expect(await asA((tx) => getConnection(tx, connection.id))).toMatchObject({
      status: 'revoked',
    });
    expect(await problemCards(connection.id)).toHaveLength(0);
  });

  it('finds connections by Nango ID and by active account, within the tenant only', async () => {
    const connection = await asA((tx) => createTestConnection(tx, A));
    expect((await asA((tx) => getConnectionByNangoId(tx, connection.nangoConnectionId)))?.id).toBe(
      connection.id,
    );
    expect(
      await asB((tx) => getConnectionByNangoId(tx, connection.nangoConnectionId)),
    ).toBeUndefined();
    expect(
      (
        await asA((tx) =>
          findLiveAccountConnection(tx, 'gmail', connection.externalAccountId ?? randomUUID()),
        )
      )?.id,
    ).toBe(connection.id);
    expect(
      await asB((tx) =>
        findLiveAccountConnection(tx, 'gmail', connection.externalAccountId ?? randomUUID()),
      ),
    ).toBeUndefined();
  });
});
