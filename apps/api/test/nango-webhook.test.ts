import { randomUUID } from 'node:crypto';
import { createConnection, schema, sql, withTenant } from '@effectief/db';
import { signNangoBody } from '@effectief/integrations/nango';
import { nangoWebhookFixtures as fixtures } from '@effectief/integrations/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  appDatabase,
  createTestApp,
  enqueuedNangoWebhooks,
  registerTenant,
  removeRegisteredTenants,
  reportedErrors,
  testEnv,
} from './helpers.ts';

// POST /webhooks/nango (docs/integrations.md §4.1): signature on the raw body,
// Zod, environment, tenant from our database, stored once, one job, 200.

const logs: Record<string, unknown>[] = [];
let app: FastifyInstance;
let tenantA: { tenantId: string; userId: string };
let tenantB: { tenantId: string; userId: string };
let connectionA: { id: string; nangoConnectionId: string };
let connectionB: { id: string; nangoConnectionId: string };

async function seedConnection(tenant: { tenantId: string; userId: string }) {
  return withTenant(appDatabase.db, tenant.tenantId, (tx) =>
    createConnection(tx, {
      provider: 'gmail',
      nangoIntegrationId: 'gmail',
      nangoConnectionId: randomUUID(),
      connectedByUserId: tenant.userId,
      actor: { type: 'user', userId: tenant.userId },
    }),
  );
}

beforeAll(async () => {
  app = await createTestApp({
    env: { LOG_LEVEL: 'info' },
    logStream: { write: (line) => logs.push(JSON.parse(line)) },
  });
  tenantA = await registerTenant(app, 'Bedrijf A');
  tenantB = await registerTenant(app, 'Bedrijf B');
  connectionA = await seedConnection(tenantA);
  connectionB = await seedConnection(tenantB);
});

afterAll(async () => {
  await app.close();
  await removeRegisteredTenants();
});

beforeEach(() => {
  logs.length = 0;
  enqueuedNangoWebhooks.length = 0;
  reportedErrors.length = 0;
});

const post = (body: string, signature?: string) =>
  app.inject({
    method: 'POST',
    url: '/webhooks/nango',
    headers: {
      'content-type': 'application/json',
      ...(signature === undefined ? {} : { 'x-nango-hmac-sha256': signature }),
    },
    payload: body,
  });

const signed = (value: unknown) => {
  const body = JSON.stringify(value);
  return post(body, signNangoBody(body, testEnv.NANGO_WEBHOOK_SIGNING_KEY));
};

const syncFor = (nangoConnectionId: string) => ({
  ...fixtures.syncSuccess,
  connectionId: nangoConnectionId,
  modifiedAfter: new Date().toISOString(),
});

async function deliveriesOf(tenantId: string) {
  return withTenant(appDatabase.db, tenantId, (tx) => tx.select().from(schema.webhookDeliveries));
}

async function allDeliveryCount() {
  const counts = await Promise.all([
    deliveriesOf(tenantA.tenantId),
    deliveriesOf(tenantB.tenantId),
  ]);
  return counts.flat().length;
}

describe('signature', () => {
  it('refuses a missing signature with 401 and stores nothing', async () => {
    const before = await allDeliveryCount();
    const response = await post(JSON.stringify(syncFor(connectionA.nangoConnectionId)));
    expect(response.statusCode).toBe(401);
    expect(await allDeliveryCount()).toBe(before);
    expect(enqueuedNangoWebhooks).toHaveLength(0);
  });

  it('refuses a wrong signature, or one over other bytes, with 401', async () => {
    const before = await allDeliveryCount();
    const body = JSON.stringify(syncFor(connectionA.nangoConnectionId));
    expect((await post(body, signNangoBody(body, 'another-key'))).statusCode).toBe(401);
    expect((await post(body, 'f'.repeat(64))).statusCode).toBe(401);
    // Same JSON, other bytes: the signature is over the raw body, not the parsed one.
    const spaced = JSON.stringify(JSON.parse(body), null, 2);
    expect(
      (await post(spaced, signNangoBody(body, testEnv.NANGO_WEBHOOK_SIGNING_KEY))).statusCode,
    ).toBe(401);
    expect(await allDeliveryCount()).toBe(before);
  });
});

describe('body', () => {
  it('answers 400 to a validly signed body that is not JSON or not a valid webhook', async () => {
    const notJson = 'not json';
    expect(
      (await post(notJson, signNangoBody(notJson, testEnv.NANGO_WEBHOOK_SIGNING_KEY))).statusCode,
    ).toBe(400);
    const { connectionId: _, ...withoutConnection } = syncFor(connectionA.nangoConnectionId);
    const response = await signed(withoutConnection);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } });
    expect(enqueuedNangoWebhooks).toHaveLength(0);
  });

  it('acknowledges a type it does not handle and stores nothing', async () => {
    const before = await allDeliveryCount();
    const response = await signed({
      ...fixtures.forward,
      connectionId: connectionA.nangoConnectionId,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: false });
    expect(await allDeliveryCount()).toBe(before);
  });
});

describe('environment', () => {
  it('ignores an auth webhook of another Nango environment', async () => {
    const before = await allDeliveryCount();
    const response = await signed({
      ...fixtures.authRefreshFailed,
      connectionId: connectionA.nangoConnectionId,
      environment: 'prod',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: false });
    expect(await allDeliveryCount()).toBe(before);
    expect(logs.some((line) => line.msg === 'nango webhook: other environment')).toBe(true);
  });

  it('compares the environment name without case', async () => {
    const response = await signed({
      ...fixtures.authDeletion,
      connectionId: connectionA.nangoConnectionId,
      environment: 'STAGING',
    });
    expect(response.json()).toEqual({ received: true });
  });
});

describe('tenant lookup', () => {
  it('ignores and logs a webhook for a connection of an unknown tenant, without an error', async () => {
    const before = await allDeliveryCount();
    const unknown = randomUUID();
    const response = await signed(syncFor(unknown));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: false });
    expect(await allDeliveryCount()).toBe(before);
    expect(enqueuedNangoWebhooks).toHaveLength(0);
    expect(reportedErrors).toHaveLength(0);
    const line = logs.find((entry) => entry.msg === 'nango webhook: unknown connection, ignored');
    expect(line).toMatchObject({ level: 30, nangoConnectionId: unknown, integrationId: 'gmail' });
  });

  it('ignores a creation webhook until connect attempts exist, even with tags of a tenant', async () => {
    const before = await allDeliveryCount();
    const response = await signed({
      ...fixtures.authCreation,
      connectionId: randomUUID(),
      tags: { organization_id: tenantA.tenantId, end_user_id: tenantA.userId },
    });
    expect(response.json()).toEqual({ received: false });
    expect(await allDeliveryCount()).toBe(before);
  });

  it('stores the delivery for the tenant of the connection only, and enqueues one job', async () => {
    const response = await signed(syncFor(connectionB.nangoConnectionId));
    expect(response.json()).toEqual({ received: true });
    const [job] = enqueuedNangoWebhooks;
    expect(job?.tenantId).toBe(tenantB.tenantId);
    const deliveries = await deliveriesOf(tenantB.tenantId);
    const stored = deliveries.find((delivery) => delivery.id === job?.deliveryId);
    expect(stored).toMatchObject({
      connectionId: connectionB.id,
      source: 'nango',
      status: 'received',
    });
    expect((await deliveriesOf(tenantA.tenantId)).map((d) => d.id)).not.toContain(job?.deliveryId);
  });

  it('takes the tenant from the connection, not from the tags', async () => {
    await signed({
      ...fixtures.authRefreshFailed,
      connectionId: connectionB.nangoConnectionId,
      tags: { organization_id: tenantA.tenantId, end_user_id: tenantA.userId },
    });
    expect(enqueuedNangoWebhooks.map((job) => job.tenantId)).toEqual([tenantB.tenantId]);
  });
});

describe('repeats', () => {
  it('stores a repeated webhook once and enqueues it under one job id', async () => {
    const body = syncFor(connectionA.nangoConnectionId);
    const first = await signed(body);
    const second = await signed(body);
    expect(first.json()).toEqual({ received: true });
    expect(second.json()).toEqual({ received: true });
    const ids = new Set(enqueuedNangoWebhooks.map((job) => job.deliveryId));
    expect(ids.size).toBe(1);
    const matching = (await deliveriesOf(tenantA.tenantId)).filter(
      (delivery) =>
        (delivery.payload as { modifiedAfter?: string }).modifiedAfter === body.modifiedAfter,
    );
    expect(matching).toHaveLength(1);
  });

  it('does not enqueue a repeat that was already processed', async () => {
    const body = syncFor(connectionA.nangoConnectionId);
    await signed(body);
    const [job] = enqueuedNangoWebhooks;
    await withTenant(appDatabase.db, tenantA.tenantId, (tx) =>
      tx.execute(
        sql`update webhook_deliveries set status = 'processed', processed_at = now() where id = ${job?.deliveryId}`,
      ),
    );
    enqueuedNangoWebhooks.length = 0;
    expect((await signed(body)).json()).toEqual({ received: true });
    expect(enqueuedNangoWebhooks).toHaveLength(0);
  });
});

describe('what is stored and logged', () => {
  it('stores no provider error text, email address or nonce, and logs no body', async () => {
    await signed({
      ...fixtures.authRefreshFailed,
      connectionId: connectionA.nangoConnectionId,
      tags: { ...fixtures.authRefreshFailed.tags, end_user_email: 'jan@example.com' },
      error: { type: 'refresh_failed', description: 'Jan Jansen <jan@example.com> revoked' },
    });
    const [job] = enqueuedNangoWebhooks;
    const stored = (await deliveriesOf(tenantA.tenantId)).find((d) => d.id === job?.deliveryId);
    const text = JSON.stringify(stored?.payload) + JSON.stringify(logs);
    expect(text).not.toMatch(/example\.com|Jan Jansen/);
    expect(text).not.toContain(fixtures.ids.nonce);
    expect(stored?.payload).toMatchObject({ error: { type: 'refresh_failed' } });
  });
});
