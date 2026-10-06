import { randomUUID } from 'node:crypto';
import {
  type Connection,
  createConnectAttempt,
  createConnection,
  disconnectConnection,
  eq,
  expireConnection,
  getConnectAttempt,
  getConnection,
  getWebhookDelivery,
  recordWebhookDelivery,
  schema,
  type TenantTransaction,
  withTenant,
} from '@effectief/db';
import { openTestDatabases, type TestTenant } from '@effectief/db/testing';
import {
  externalAccountIdOf,
  NangoApiError,
  type NangoClient,
} from '@effectief/integrations/nango';
import { createFakeNango } from '@effectief/integrations/testing';
import type { StoredNangoWebhook } from '@effectief/shared';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  handleAuthWebhook,
  handleSyncWebhook,
  type LifecycleDependencies,
} from '../src/connections/lifecycle.ts';
import { processTenantAttempts, processTenantHealth } from '../src/jobs/connections.ts';
import { processNangoWebhookJob } from '../src/jobs/nango-webhook.ts';

// Connecting and the life of a connection in the worker (docs/integrations.md
// §2.2–§2.5, §4.6, §5): never the wrong tenant, never another mailbox.

const db = openTestDatabases();
const log = pino({ level: 'silent' });
let A: TestTenant;
let B: TestTenant;
const HOUR = 60 * 60 * 1000;

/** What the fake Nango answers; tests change it. */
let account = { accountId: 'info@a.example', email: 'Info@A.example' };
let nangoConnections: { connectionId: string; integrationId: string }[] = [];
let health: { authError: boolean } | 'gone' = { authError: false };
const deleted: string[] = [];
const purges: { tenantId: string; connectionId: string }[] = [];
const ingests: { tenantId: string; connectionId: string }[] = [];

const nango: NangoClient = createFakeNango({
  triggerAction: async (_ref, _name, output) => output.parse(account),
  listConnectionsByTags: async (tags) =>
    nangoConnections.map((c) => ({ ...c, provider: 'google-mail', tags })),
  deleteConnection: async (ref) => {
    deleted.push(ref.connectionId);
    return { deleted: true };
  },
  getConnection: async (ref) => {
    if (health === 'gone') throw new NangoApiError('not_found', 'get connection', 404);
    return { ...ref, provider: 'google-mail', tags: {}, authError: health.authError };
  },
});

let clock = new Date();
const deps: LifecycleDependencies = {
  db: db.app.db,
  nango,
  log,
  now: () => clock,
  enqueuePurge: async (job) => {
    purges.push(job);
  },
  enqueueIngest: async (job) => {
    ingests.push(job);
  },
};

const asTenant = <T>(tenant: TestTenant, fn: (tx: TenantTransaction) => Promise<T>) =>
  withTenant(db.app.db, tenant.tenantId, fn);

beforeAll(async () => {
  A = await db.createTenant();
  B = await db.createTenant();
});
afterAll(() => db.close());
beforeEach(() => {
  account = { accountId: `info-${randomUUID()}@a.example`, email: 'Info@A.example' };
  nangoConnections = [];
  health = { authError: false };
  deleted.length = 0;
  purges.length = 0;
  ingests.length = 0;
  clock = new Date();
});

const startAttempt = (tenant: TestTenant) =>
  asTenant(tenant, (tx) =>
    createConnectAttempt(tx, {
      provider: 'gmail',
      nangoIntegrationId: 'gmail',
      createdByUserId: tenant.userId,
    }),
  );

const authPayload = (
  operation: 'creation' | 'override' | 'refresh' | 'deletion',
  nangoConnectionId: string,
  extra: Partial<Extract<StoredNangoWebhook, { type: 'auth' }>> = {},
): Extract<StoredNangoWebhook, { type: 'auth' }> => ({
  type: 'auth',
  operation,
  connectionId: nangoConnectionId,
  providerConfigKey: 'gmail',
  provider: 'google-mail',
  environment: 'staging',
  success: true,
  ...extra,
});

/** Stores a delivery and runs the job as the worker does. */
async function deliver(
  tenant: TestTenant,
  target: { connectionId: string } | { connectAttemptId: string },
  payload: StoredNangoWebhook,
) {
  const { delivery } = await asTenant(tenant, (tx) =>
    recordWebhookDelivery(tx, {
      ...target,
      source: 'nango',
      deliveryId: randomUUID().replaceAll('-', ''),
      payload,
    }),
  );
  await processNangoWebhookJob(
    { tenantId: tenant.tenantId, deliveryId: delivery.id },
    { jobId: `job-${delivery.id}` },
    {
      db: db.app.db,
      log,
      handlers: {
        auth: ({ tenantId, delivery: d, payload: p, jobId, commit }) =>
          p.type === 'auth'
            ? handleAuthWebhook(deps, {
                tenantId,
                connectionId: d.connectionId,
                connectAttemptId: d.connectAttemptId,
                payload: p,
                jobId,
                commit,
              })
            : Promise.resolve(),
        sync: ({ tenantId, delivery: d, payload: p, jobId, commit }) =>
          p.type === 'sync'
            ? handleSyncWebhook(deps, {
                tenantId,
                connectionId: d.connectionId,
                payload: p,
                jobId,
                commit,
              })
            : Promise.resolve(),
      },
    },
  );
  return asTenant(tenant, (tx) => getWebhookDelivery(tx, delivery.id));
}

const connectionsOf = (tenant: TestTenant) =>
  asTenant(tenant, (tx) => tx.select().from(schema.connections));

async function connected(tenant: TestTenant): Promise<Connection> {
  const attempt = await startAttempt(tenant);
  const nangoConnectionId = randomUUID();
  await deliver(
    tenant,
    { connectAttemptId: attempt.id },
    authPayload('creation', nangoConnectionId, {
      tags: { organization_id: tenant.tenantId, end_user_id: tenant.userId },
    }),
  );
  const rows = await connectionsOf(tenant);
  const connection = rows.find((row) => row.nangoConnectionId === nangoConnectionId);
  if (!connection) throw new Error('not connected');
  return connection;
}

describe('creation webhook', () => {
  it('creates the connection for the attempt’s tenant, consumes the attempt, labels the mailbox', async () => {
    const attempt = await startAttempt(A);
    const nangoConnectionId = randomUUID();
    const delivery = await deliver(
      A,
      { connectAttemptId: attempt.id },
      authPayload('creation', nangoConnectionId, {
        tags: { organization_id: A.tenantId, end_user_id: A.userId },
      }),
    );
    expect(delivery?.status).toBe('processed');
    const connection = (await connectionsOf(A)).find(
      (row) => row.nangoConnectionId === nangoConnectionId,
    );
    expect(connection).toMatchObject({
      tenantId: A.tenantId,
      provider: 'gmail',
      status: 'active',
      accountLabel: 'info@a.example',
      externalAccountId: externalAccountIdOf('gmail', account.accountId),
      connectedByUserId: A.userId,
    });
    expect(connection?.externalAccountId).not.toContain('@');
    expect(await asTenant(A, (tx) => getConnectAttempt(tx, attempt.id))).toMatchObject({
      connectionId: connection?.id,
      failureCode: null,
    });
    expect(
      (await connectionsOf(B)).some((row) => row.nangoConnectionId === nangoConnectionId),
    ).toBe(false);
  });

  it('rejects the nonce of tenant A with the tags of tenant B', async () => {
    const attempt = await startAttempt(A);
    const nangoConnectionId = randomUUID();
    await deliver(
      A,
      { connectAttemptId: attempt.id },
      authPayload('creation', nangoConnectionId, {
        tags: { organization_id: B.tenantId, end_user_id: B.userId },
      }),
    );
    expect(await asTenant(A, (tx) => getConnectAttempt(tx, attempt.id))).toMatchObject({
      failureCode: 'rejected',
      connectionId: null,
    });
    for (const tenant of [A, B]) {
      expect(
        (await connectionsOf(tenant)).some((row) => row.nangoConnectionId === nangoConnectionId),
      ).toBe(false);
    }
    // Left at Nango: on the shared environment it may belong to someone else (§2.2).
    expect(deleted).toHaveLength(0);
  });

  it('rejects a connection of another integration than the attempt', async () => {
    const attempt = await startAttempt(A);
    await deliver(
      A,
      { connectAttemptId: attempt.id },
      authPayload('creation', randomUUID(), {
        providerConfigKey: 'outlook',
        tags: { organization_id: A.tenantId, end_user_id: A.userId },
      }),
    );
    expect((await asTenant(A, (tx) => getConnectAttempt(tx, attempt.id)))?.failureCode).toBe(
      'rejected',
    );
  });

  it('does nothing for a consumed attempt', async () => {
    const first = await connected(A);
    const attempt = await asTenant(A, (tx) =>
      tx
        .select()
        .from(schema.connectAttempts)
        .where(eq(schema.connectAttempts.connectionId, first.id)),
    );
    const before = (await connectionsOf(A)).length;
    const delivery = await deliver(
      A,
      { connectAttemptId: attempt[0]?.id ?? '' },
      authPayload('creation', randomUUID(), {
        tags: { organization_id: A.tenantId, end_user_id: A.userId },
      }),
    );
    expect(delivery?.status).toBe('processed');
    expect((await connectionsOf(A)).length).toBe(before);
  });

  it('closes an expired attempt and removes its Nango connection', async () => {
    const attempt = await startAttempt(A);
    clock = new Date(Date.now() + 25 * HOUR);
    const nangoConnectionId = randomUUID();
    await deliver(
      A,
      { connectAttemptId: attempt.id },
      authPayload('creation', nangoConnectionId, {
        tags: { organization_id: A.tenantId, end_user_id: A.userId },
      }),
    );
    expect((await asTenant(A, (tx) => getConnectAttempt(tx, attempt.id)))?.failureCode).toBe(
      'expired',
    );
    expect(deleted).toEqual([nangoConnectionId]);
  });

  it('refuses the same mailbox twice and removes the second Nango connection', async () => {
    await connected(A);
    const attempt = await startAttempt(A);
    const second = randomUUID();
    await deliver(
      A,
      { connectAttemptId: attempt.id },
      authPayload('creation', second, {
        tags: { organization_id: A.tenantId, end_user_id: A.userId },
      }),
    );
    expect((await asTenant(A, (tx) => getConnectAttempt(tx, attempt.id)))?.failureCode).toBe(
      'duplicate_account',
    );
    expect((await connectionsOf(A)).some((row) => row.nangoConnectionId === second)).toBe(false);
    expect(deleted).toEqual([second]);
  });

  it('refuses the same mailbox while its connection is expired: that one is renewed instead', async () => {
    const first = await connected(A);
    await asTenant(A, (tx) =>
      expireConnection(tx, { connectionId: first.id, reason: 'invalid_grant' }),
    );
    const attempt = await startAttempt(A);
    const second = randomUUID();
    await deliver(
      A,
      { connectAttemptId: attempt.id },
      authPayload('creation', second, {
        tags: { organization_id: A.tenantId, end_user_id: A.userId },
      }),
    );
    expect((await asTenant(A, (tx) => getConnectAttempt(tx, attempt.id)))?.failureCode).toBe(
      'duplicate_account',
    );
    expect(deleted).toEqual([second]);
  });

  it('connects the same mailbox again after disconnecting: a new connection', async () => {
    const first = await connected(A);
    await asTenant(A, (tx) =>
      disconnectConnection(tx, {
        connectionId: first.id,
        actor: { type: 'user', userId: A.userId },
      }),
    );
    const again = await connected(A);
    expect(again.id).not.toBe(first.id);
    expect(again).toMatchObject({ status: 'active', externalAccountId: first.externalAccountId });
    expect((await asTenant(A, (tx) => getConnection(tx, first.id)))?.status).toBe('revoked');
  });

  it('allows the same mailbox in another tenant', async () => {
    await connected(A);
    const inB = await connected(B);
    expect(inB.tenantId).toBe(B.tenantId);
  });
});

describe('auth webhooks on a connection', () => {
  const statusOf = async (connection: Connection) =>
    asTenant(A, (tx) => getConnection(tx, connection.id));
  const openProblemCards = (connection: Connection) =>
    asTenant(A, (tx) =>
      tx.select().from(schema.cards).where(eq(schema.cards.connectionId, connection.id)),
    ).then((rows) => rows.filter((row) => row.status === 'open'));

  it('expires on a failed refresh with a card, and comes back on recovery', async () => {
    const connection = await connected(A);
    await deliver(
      A,
      { connectionId: connection.id },
      authPayload('refresh', connection.nangoConnectionId, {
        success: false,
        error: { type: 'refresh_token_external_error' },
      }),
    );
    expect(await statusOf(connection)).toMatchObject({
      status: 'expired',
      statusReason: 'invalid_grant',
    });
    expect(await openProblemCards(connection)).toHaveLength(1);

    await deliver(
      A,
      { connectionId: connection.id },
      authPayload('refresh', connection.nangoConnectionId),
    );
    expect(await statusOf(connection)).toMatchObject({
      status: 'active',
      statusReason: 'auth_recovered',
    });
    expect(await openProblemCards(connection)).toHaveLength(0);
    // Resumes from its cursor right away, not at the next sweep.
    expect(ingests).toEqual([{ tenantId: A.tenantId, connectionId: connection.id }]);
  });

  it('expires with account_mismatch when re-authorized with another account', async () => {
    const connection = await connected(A);
    account = { accountId: 'someone-else@b.example', email: 'someone-else@b.example' };
    await deliver(
      A,
      { connectionId: connection.id },
      authPayload('override', connection.nangoConnectionId),
    );
    expect(await statusOf(connection)).toMatchObject({
      status: 'expired',
      statusReason: 'account_mismatch',
      accountLabel: 'info@a.example',
    });
    expect(await openProblemCards(connection)).toHaveLength(1);
    expect(ingests).toEqual([]);
  });

  it('reactivates an expired connection re-authorized with the same account', async () => {
    const connection = await connected(A);
    await deliver(
      A,
      { connectionId: connection.id },
      authPayload('refresh', connection.nangoConnectionId, { success: false }),
    );
    await deliver(
      A,
      { connectionId: connection.id },
      authPayload('override', connection.nangoConnectionId),
    );
    expect(await statusOf(connection)).toMatchObject({
      status: 'active',
      statusReason: 'reauthorized',
    });
    expect(ingests).toEqual([{ tenantId: A.tenantId, connectionId: connection.id }]);
  });

  it('revokes on deletion and enqueues the purge; late webhooks change nothing', async () => {
    const connection = await connected(A);
    await deliver(
      A,
      { connectionId: connection.id },
      authPayload('deletion', connection.nangoConnectionId),
    );
    expect(await statusOf(connection)).toMatchObject({
      status: 'revoked',
      statusReason: 'provider_revoked',
    });
    expect(purges).toEqual([{ tenantId: A.tenantId, connectionId: connection.id }]);
    const late = await deliver(
      A,
      { connectionId: connection.id },
      authPayload('refresh', connection.nangoConnectionId, { success: false }),
    );
    expect(late?.status).toBe('processed');
    expect((await statusOf(connection))?.status).toBe('revoked');
  });

  it('marks the delivery failed when Nango is down, without changing the connection', async () => {
    const connection = await connected(A);
    await deliver(
      A,
      { connectionId: connection.id },
      authPayload('refresh', connection.nangoConnectionId, { success: false }),
    );
    const failing: LifecycleDependencies = {
      ...deps,
      nango: createFakeNango(),
    };
    const { delivery } = await asTenant(A, (tx) =>
      recordWebhookDelivery(tx, {
        connectionId: connection.id,
        source: 'nango',
        deliveryId: randomUUID().replaceAll('-', ''),
        payload: authPayload('override', connection.nangoConnectionId),
      }),
    );
    await expect(
      processNangoWebhookJob(
        { tenantId: A.tenantId, deliveryId: delivery.id },
        { jobId: 'j-down' },
        {
          db: db.app.db,
          log,
          handlers: {
            auth: ({ tenantId, delivery: d, payload: p, jobId, commit }) =>
              p.type === 'auth'
                ? handleAuthWebhook(failing, {
                    tenantId,
                    connectionId: d.connectionId,
                    connectAttemptId: d.connectAttemptId,
                    payload: p,
                    jobId,
                    commit,
                  })
                : Promise.resolve(),
          },
        },
      ),
    ).rejects.toBeInstanceOf(NangoApiError);
    expect(await asTenant(A, (tx) => getWebhookDelivery(tx, delivery.id))).toMatchObject({
      status: 'failed',
      lastErrorCode: 'nango_unavailable',
    });
    expect((await statusOf(connection))?.status).toBe('expired');
  });
});

describe('sync webhooks and repeated problems', () => {
  const syncPayload = (
    nangoConnectionId: string,
    success: boolean,
  ): Extract<StoredNangoWebhook, { type: 'sync' }> => ({
    type: 'sync',
    connectionId: nangoConnectionId,
    providerConfigKey: 'gmail',
    syncName: 'inbox-messages',
    model: 'InboxMessage',
    success,
    ...(success
      ? { responseResults: { added: 1, updated: 0, deleted: 0 } }
      : { error: { type: 'script_http_error' } }),
  });
  const problemCards = (connection: Connection) =>
    asTenant(A, (tx) =>
      tx.select().from(schema.cards).where(eq(schema.cards.connectionId, connection.id)),
    );

  it('a finished sync enqueues the ingest of that connection', async () => {
    const connection = await connected(A);
    const delivery = await deliver(
      A,
      { connectionId: connection.id },
      syncPayload(connection.nangoConnectionId, true),
    );
    expect(delivery?.status).toBe('processed');
    expect(ingests).toEqual([{ tenantId: A.tenantId, connectionId: connection.id }]);
  });

  it('a failed sync of a connection that still works changes nothing', async () => {
    const connection = await connected(A);
    await deliver(
      A,
      { connectionId: connection.id },
      syncPayload(connection.nangoConnectionId, false),
    );
    expect((await asTenant(A, (tx) => getConnection(tx, connection.id)))?.status).toBe('active');
    expect(await problemCards(connection)).toHaveLength(0);
    expect(ingests).toEqual([]);
  });

  it('a failed sync with lost access expires the connection: one card, however often it is reported', async () => {
    const connection = await connected(A);
    health = { authError: true };
    await deliver(
      A,
      { connectionId: connection.id },
      syncPayload(connection.nangoConnectionId, false),
    );
    expect(await asTenant(A, (tx) => getConnection(tx, connection.id))).toMatchObject({
      status: 'expired',
      statusReason: 'invalid_grant',
    });

    // The same problem again, through every route that reports it.
    await deliver(
      A,
      { connectionId: connection.id },
      syncPayload(connection.nangoConnectionId, false),
    );
    await deliver(
      A,
      { connectionId: connection.id },
      authPayload('refresh', connection.nangoConnectionId, { success: false }),
    );
    await deliver(
      A,
      { connectionId: connection.id },
      authPayload('refresh', connection.nangoConnectionId, { success: false }),
    );
    await processTenantHealth({ tenantId: A.tenantId }, { jobId: 'h-repeat' }, deps);

    const cards = await problemCards(connection);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: 'connection_problem', status: 'open' });
    expect((await asTenant(A, (tx) => getConnection(tx, connection.id)))?.status).toBe('expired');
    // Not fetched while expired: mail-ingest.test.ts ('not active') and the sweep skip it.
    expect(ingests).toEqual([]);
  });
});

describe('sweep: open attempts', () => {
  it('finishes an attempt whose webhook never came, found by its nonce', async () => {
    const attempt = await startAttempt(A);
    const nangoConnectionId = randomUUID();
    nangoConnections = [{ connectionId: nangoConnectionId, integrationId: 'gmail' }];
    clock = new Date(Date.now() + HOUR);
    const counts = await processTenantAttempts({ tenantId: A.tenantId }, { jobId: 's1' }, deps);
    expect(counts.finished).toBeGreaterThanOrEqual(1);
    expect((await asTenant(A, (tx) => getConnectAttempt(tx, attempt.id)))?.connectionId).not.toBe(
      null,
    );
  });

  it('leaves young attempts alone', async () => {
    const attempt = await startAttempt(A);
    nangoConnections = [{ connectionId: randomUUID(), integrationId: 'gmail' }];
    await processTenantAttempts({ tenantId: A.tenantId }, { jobId: 's2' }, deps);
    expect((await asTenant(A, (tx) => getConnectAttempt(tx, attempt.id)))?.consumedAt).toBeNull();
  });

  it('removes what Nango has for an attempt older than a day and closes it', async () => {
    const attempt = await startAttempt(A);
    const orphan = randomUUID();
    nangoConnections = [{ connectionId: orphan, integrationId: 'gmail' }];
    clock = new Date(Date.now() + 25 * HOUR);
    await processTenantAttempts({ tenantId: A.tenantId }, { jobId: 's3' }, deps);
    expect((await asTenant(A, (tx) => getConnectAttempt(tx, attempt.id)))?.failureCode).toBe(
      'expired',
    );
    expect(deleted).toContain(orphan);
  });
});

describe('sweep: health check', () => {
  /** A fresh tenant with one active connection, so counts are exact. */
  async function single() {
    const other = await db.createTenant();
    const connection = await asTenant(other, (tx) =>
      createConnection(tx, {
        provider: 'gmail',
        nangoIntegrationId: 'gmail',
        nangoConnectionId: randomUUID(),
        externalAccountId: externalAccountIdOf('gmail', account.accountId),
        accountLabel: 'info@a.example',
        connectedByUserId: other.userId,
        actor: { type: 'system' },
      }),
    );
    return { tenant: other, connection };
  }

  it('expires a connection Nango reports an auth error for (missed refresh webhook)', async () => {
    const { tenant, connection } = await single();
    health = { authError: true };
    expect(await processTenantHealth({ tenantId: tenant.tenantId }, { jobId: 'h1' }, deps)).toEqual(
      {
        expired: 1,
      },
    );
    expect((await asTenant(tenant, (tx) => getConnection(tx, connection.id)))?.status).toBe(
      'expired',
    );
  });

  it('reactivates an expired connection that works again for the same account', async () => {
    const { tenant, connection } = await single();
    health = { authError: true };
    await processTenantHealth({ tenantId: tenant.tenantId }, { jobId: 'h2' }, deps);
    health = { authError: false };
    expect(await processTenantHealth({ tenantId: tenant.tenantId }, { jobId: 'h3' }, deps)).toEqual(
      {
        reactivated: 1,
      },
    );
    expect(await asTenant(tenant, (tx) => getConnection(tx, connection.id))).toMatchObject({
      status: 'active',
      statusReason: 'auth_recovered',
    });
  });

  it('keeps it expired when it works for another account', async () => {
    const { tenant, connection } = await single();
    health = { authError: true };
    await processTenantHealth({ tenantId: tenant.tenantId }, { jobId: 'h4' }, deps);
    health = { authError: false };
    account = { accountId: 'other@b.example', email: 'other@b.example' };
    expect(await processTenantHealth({ tenantId: tenant.tenantId }, { jobId: 'h5' }, deps)).toEqual(
      {
        mismatch: 1,
      },
    );
    expect((await asTenant(tenant, (tx) => getConnection(tx, connection.id)))?.status).toBe(
      'expired',
    );
  });

  it('revokes and purges a connection that is gone at Nango (missed deletion webhook)', async () => {
    const { tenant, connection } = await single();
    health = 'gone';
    await processTenantHealth({ tenantId: tenant.tenantId }, { jobId: 'h6' }, deps);
    expect((await asTenant(tenant, (tx) => getConnection(tx, connection.id)))?.status).toBe(
      'revoked',
    );
    expect(purges).toEqual([{ tenantId: tenant.tenantId, connectionId: connection.id }]);
  });
});
