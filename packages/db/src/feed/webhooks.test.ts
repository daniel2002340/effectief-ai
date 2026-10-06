import { randomUUID } from 'node:crypto';
import type { StoredNangoWebhook } from '@effectief/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeExpiredBatch } from '../lifecycle/retention.ts';
import { webhookDeliveries } from '../schema/index.ts';
import {
  checkViolation,
  foreignKeyViolation,
  openTestDatabases,
  type TestTenant,
} from '../test-support.ts';
import { type TenantTransaction, withTenant } from '../with-tenant.ts';
import { createTestConnection } from './test-fixtures.ts';
import {
  getWebhookDelivery,
  markWebhookDeliveryFailed,
  markWebhookDeliveryProcessed,
  nangoPayloadOf,
  recordWebhookDelivery,
  resolveConnection,
} from './webhooks.ts';

// webhook_deliveries and resolve_connection() (#038): stored once per
// delivery, only for the tenant of its connection, never readable or
// changeable by another tenant.

const db = openTestDatabases();
let A: TestTenant;
let B: TestTenant;
let connectionA: { id: string; nangoIntegrationId: string; nangoConnectionId: string };
let connectionB: { id: string; nangoIntegrationId: string; nangoConnectionId: string };
const DAY_MS = 24 * 60 * 60 * 1000;

const asA = <T>(fn: (tx: TenantTransaction) => Promise<T>) => withTenant(db.app.db, A.tenantId, fn);
const asB = <T>(fn: (tx: TenantTransaction) => Promise<T>) => withTenant(db.app.db, B.tenantId, fn);

const syncPayload = (nangoConnectionId: string): StoredNangoWebhook => ({
  type: 'sync',
  connectionId: nangoConnectionId,
  providerConfigKey: 'google-mail',
  syncName: 'inbox-messages',
  model: 'InboxMessage',
  success: true,
  responseResults: { added: 1, updated: 0, deleted: 0 },
});

const record = (tx: TenantTransaction, connection: typeof connectionA, deliveryId?: string) =>
  recordWebhookDelivery(tx, {
    connectionId: connection.id,
    source: 'nango',
    deliveryId: deliveryId ?? randomUUID().replaceAll('-', ''),
    payload: syncPayload(connection.nangoConnectionId),
  });

beforeAll(async () => {
  A = await db.createTenant();
  B = await db.createTenant();
  connectionA = await asA((tx) => createTestConnection(tx, A));
  connectionB = await asB((tx) => createTestConnection(tx, B));
});
afterAll(() => db.close());

describe('recordWebhookDelivery', () => {
  it('stores a delivery once; a repeat returns the stored row', async () => {
    const deliveryId = 'a'.repeat(64);
    const first = await asA((tx) => record(tx, connectionA, deliveryId));
    const again = await asA((tx) => record(tx, connectionA, deliveryId));
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, delivery: { id: first.delivery.id } });
    expect(first.delivery).toMatchObject({ status: 'received', attempts: 0, tenantId: A.tenantId });
    expect(nangoPayloadOf(first.delivery)).toEqual(syncPayload(connectionA.nangoConnectionId));
  });

  it('keeps the same delivery ID apart per tenant', async () => {
    const deliveryId = 'b'.repeat(64);
    const a = await asA((tx) => record(tx, connectionA, deliveryId));
    const b = await asB((tx) => record(tx, connectionB, deliveryId));
    expect(a.created && b.created).toBe(true);
  });

  it('refuses a payload that is not a stored Nango webhook', async () => {
    await expect(
      asA((tx) =>
        recordWebhookDelivery(tx, {
          connectionId: connectionA.id,
          source: 'nango',
          deliveryId: 'c'.repeat(64),
          payload: { type: 'sync', body: 'mail text' } as never,
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('status', () => {
  it('marks processed and failed, counting attempts; a processed one stays processed', async () => {
    const { delivery } = await asA((tx) => record(tx, connectionA));
    await asA((tx) => markWebhookDeliveryFailed(tx, delivery.id, 'unknown'));
    expect(await asA((tx) => getWebhookDelivery(tx, delivery.id))).toMatchObject({
      status: 'failed',
      lastErrorCode: 'unknown',
      attempts: 1,
    });
    await asA((tx) => markWebhookDeliveryProcessed(tx, delivery.id));
    await asA((tx) => markWebhookDeliveryFailed(tx, delivery.id, 'unknown'));
    const after = await asA((tx) => getWebhookDelivery(tx, delivery.id));
    expect(after).toMatchObject({ status: 'processed', lastErrorCode: null, attempts: 2 });
    expect(after?.processedAt).toBeInstanceOf(Date);
  });

  it('refuses processed without processed_at', async () => {
    const { delivery } = await asA((tx) => record(tx, connectionA));
    await expect(
      asA((tx) =>
        tx
          .update(webhookDeliveries)
          .set({ status: 'processed' })
          .where(eq(webhookDeliveries.id, delivery.id)),
      ),
    ).rejects.toMatchObject(checkViolation);
  });
});

describe('tenant isolation', () => {
  it('B cannot read, change or delete a delivery of A', async () => {
    const { delivery } = await asA((tx) => record(tx, connectionA));
    expect(await asB((tx) => getWebhookDelivery(tx, delivery.id))).toBeUndefined();
    const raw = await asB((tx) =>
      tx.execute(sql`select id from webhook_deliveries where id = ${delivery.id}`),
    );
    expect(raw.rows).toHaveLength(0);

    const updated = await asB((tx) =>
      tx
        .update(webhookDeliveries)
        .set({ status: 'failed', lastErrorCode: 'unknown' })
        .where(eq(webhookDeliveries.id, delivery.id))
        .returning(),
    );
    const deleted = await asB((tx) =>
      tx.delete(webhookDeliveries).where(eq(webhookDeliveries.id, delivery.id)).returning(),
    );
    expect(updated).toHaveLength(0);
    expect(deleted).toHaveLength(0);
    expect(await asA((tx) => getWebhookDelivery(tx, delivery.id))).toMatchObject({
      status: 'received',
    });
  });

  it('B cannot store a delivery for a connection of A', async () => {
    await expect(asB((tx) => record(tx, connectionA))).rejects.toMatchObject(foreignKeyViolation);
  });

  it('B cannot store a delivery in the name of A', async () => {
    await expect(
      asB((tx) =>
        tx.insert(webhookDeliveries).values({
          tenantId: A.tenantId,
          connectionId: connectionA.id,
          source: 'nango',
          deliveryId: 'd'.repeat(64),
          payload: syncPayload(connectionA.nangoConnectionId),
        }),
      ),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
  });
});

describe('resolve_connection()', () => {
  it('finds the tenant and connection by Nango integration and connection ID', async () => {
    expect(
      await resolveConnection(
        db.app.db,
        connectionA.nangoIntegrationId,
        connectionA.nangoConnectionId,
      ),
    ).toEqual({ tenantId: A.tenantId, connectionId: connectionA.id });
    expect(
      await resolveConnection(
        db.app.db,
        connectionB.nangoIntegrationId,
        connectionB.nangoConnectionId,
      ),
    ).toEqual({ tenantId: B.tenantId, connectionId: connectionB.id });
  });

  it('finds nothing for an unknown connection or the wrong integration', async () => {
    expect(await resolveConnection(db.app.db, 'google-mail', 'not-ours')).toBeUndefined();
    expect(
      await resolveConnection(db.app.db, 'outlook', connectionA.nangoConnectionId),
    ).toBeUndefined();
  });

  it('only app_runtime may execute it', async () => {
    await expect(
      db.authPool.query("select * from public.resolve_connection('a', 'b')"),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('retention', () => {
  it('deletes processed deliveries after 30 days and keeps failed ones', async () => {
    const processed = await asA(async (tx) => {
      const { delivery } = await record(tx, connectionA);
      await markWebhookDeliveryProcessed(tx, delivery.id);
      return delivery;
    });
    const failed = await asA(async (tx) => {
      const { delivery } = await record(tx, connectionA);
      await markWebhookDeliveryFailed(tx, delivery.id, 'unknown');
      return delivery;
    });

    await asA((tx) => purgeExpiredBatch(tx, { step: 'webhook_deliveries', now: new Date() }));
    expect(await asA((tx) => getWebhookDelivery(tx, processed.id))).toBeDefined();

    const later = new Date(Date.now() + 31 * DAY_MS);
    const count = await asA((tx) =>
      purgeExpiredBatch(tx, { step: 'webhook_deliveries', now: later }),
    );
    expect(count).toBeGreaterThanOrEqual(1);
    expect(await asA((tx) => getWebhookDelivery(tx, processed.id))).toBeUndefined();
    expect(await asA((tx) => getWebhookDelivery(tx, failed.id))).toMatchObject({
      status: 'failed',
    });
  });
});
