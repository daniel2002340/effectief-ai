import { randomUUID } from 'node:crypto';
import {
  consumeConnectAttempt,
  createConnection,
  eq,
  getConnectAttempt,
  getConnection,
  schema,
  withTenant,
} from '@effectief/db';
import type { NangoClient } from '@effectief/integrations/nango';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  appDatabase,
  authDatabase,
  createTestApp,
  enqueuedConnectAttempts,
  enqueuedPurges,
  registerTenant,
  removeRegisteredTenants,
  sessionCookie,
  testEnv,
} from './helpers.ts';

// connections.* (docs/integrations.md §2.1, §2.5): session required, tenant
// and member from the session, another tenant's attempt or connection is
// NOT_FOUND, Nango's IDs and the nonce never reach the browser.

type Call = { method: string; input: unknown };
const nangoCalls: Call[] = [];
let nangoConnections: { connectionId: string; integrationId: string }[] = [];

const fakeNango = {
  createConnectSession: async (input) => {
    nangoCalls.push({ method: 'createConnectSession', input });
    return { token: 'connect-token', expiresAt: new Date(Date.now() + 30 * 60_000) };
  },
  createReconnectSession: async (input) => {
    nangoCalls.push({ method: 'createReconnectSession', input });
    return { token: 'reconnect-token', expiresAt: new Date(Date.now() + 30 * 60_000) };
  },
  listConnectionsByTags: async (tags) => {
    nangoCalls.push({ method: 'listConnectionsByTags', input: tags });
    return nangoConnections.map((c) => ({ ...c, provider: 'google-mail', tags }));
  },
  getConnection: async () => {
    throw new Error('not used by the api');
  },
  deleteConnection: async () => {
    throw new Error('not used by the api');
  },
  triggerAction: async () => {
    throw new Error('not used by the api');
  },
} satisfies NangoClient;

let app: FastifyInstance;
let A: Awaited<ReturnType<typeof registerTenant>>;
let B: Awaited<ReturnType<typeof registerTenant>>;
/** A second, non-owner member of tenant A. */
let memberCookie: string;
let memberId: string;

const json = { 'content-type': 'application/json', origin: testEnv.APP_ORIGIN };

const call = (cookie: string | undefined, method: 'GET' | 'POST', path: string, body?: object) =>
  app.inject({
    method,
    url: `/api/connections${path}`,
    headers: { ...json, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { payload: body }),
  });

async function addMember(tenantId: string) {
  const email = `member-${randomUUID()}@example.test`;
  const signUp = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: json,
    payload: { name: 'Lid', email, password: 'een-lang-wachtwoord' },
  });
  const userId: string = signUp.json().user.id;
  await authDatabase.db.insert(schema.member).values({
    id: randomUUID(),
    organizationId: tenantId,
    userId,
    role: 'member',
    createdAt: new Date(),
  });
  const signIn = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: json,
    payload: { email, password: 'een-lang-wachtwoord' },
  });
  return { cookie: sessionCookie(signIn.headers['set-cookie']), userId };
}

async function seedConnection(
  tenant: { tenantId: string; userId: string },
  label = 'info@a.example',
) {
  return withTenant(appDatabase.db, tenant.tenantId, (tx) =>
    createConnection(tx, {
      provider: 'gmail',
      nangoIntegrationId: 'gmail',
      nangoConnectionId: randomUUID(),
      externalAccountId: randomUUID(),
      accountLabel: label,
      connectedByUserId: tenant.userId,
      actor: { type: 'user', userId: tenant.userId },
    }),
  );
}

beforeAll(async () => {
  app = await createTestApp({ nango: fakeNango });
  A = await registerTenant(app, 'Bedrijf A');
  B = await registerTenant(app, 'Bedrijf B');
  ({ cookie: memberCookie, userId: memberId } = await addMember(A.tenantId));
});

afterAll(async () => {
  await app.close();
  await authDatabase.db
    .delete(schema.user)
    .where(eq(schema.user.id, memberId))
    .catch(() => {});
  await removeRegisteredTenants();
});

beforeEach(() => {
  nangoCalls.length = 0;
  nangoConnections = [];
  enqueuedConnectAttempts.length = 0;
  enqueuedPurges.length = 0;
});

describe('without a session', () => {
  it.each([
    ['GET', '', undefined],
    ['POST', '/start', { provider: 'gmail' }],
    ['POST', '/complete', { attemptId: randomUUID() }],
    ['POST', '/reconnect', { connectionId: randomUUID() }],
    ['POST', '/disconnect', { connectionId: randomUUID() }],
  ] as const)('%s /connections%s is 401', async (method, path, body) => {
    const response = await call(undefined, method, path, body);
    expect(response.statusCode).toBe(401);
    expect(nangoCalls).toHaveLength(0);
  });
});

describe('list', () => {
  it('shows only the tenant’s own connections, without Nango IDs', async () => {
    const own = await seedConnection(A);
    const foreign = await seedConnection(B, 'info@b.example');
    const response = await call(A.cookie, 'GET', '');
    expect(response.statusCode).toBe(200);
    const ids = response.json().map((row: { id: string }) => row.id);
    expect(ids).toContain(own.id);
    expect(ids).not.toContain(foreign.id);
    const body = response.body;
    expect(body).not.toContain(own.nangoConnectionId);
    expect(body).not.toMatch(/nango/i);
    expect(response.json().find((row: { id: string }) => row.id === own.id)).toMatchObject({
      provider: 'gmail',
      status: 'active',
      accountLabel: 'info@a.example',
      lastSyncedAt: null,
      canManage: true,
    });
  });

  it('lets a member manage only what they connected', async () => {
    const response = await call(memberCookie, 'GET', '');
    expect(response.json().every((row: { canManage: boolean }) => !row.canManage)).toBe(true);
  });
});

describe('startConnect', () => {
  it('records an attempt for the session and tags the Nango session with its nonce', async () => {
    const response = await call(A.cookie, 'POST', '/start', { provider: 'gmail' });
    expect(response.statusCode).toBe(200);
    const { sessionToken, attemptId } = response.json();
    expect(sessionToken).toBe('connect-token');
    const attempt = await withTenant(appDatabase.db, A.tenantId, (tx) =>
      getConnectAttempt(tx, attemptId),
    );
    expect(attempt).toMatchObject({
      createdByUserId: A.userId,
      provider: 'gmail',
      consumedAt: null,
    });
    expect(nangoCalls).toEqual([
      {
        method: 'createConnectSession',
        input: {
          integrationId: 'gmail',
          tags: {
            organization_id: A.tenantId,
            end_user_id: A.userId,
            connect_attempt: attempt?.nonce,
          },
          webhookUrlOverride: undefined,
        },
      },
    ]);
    expect(response.body).not.toContain(attempt?.nonce ?? 'nonce');
  });

  it('refuses another provider', async () => {
    const response = await call(A.cookie, 'POST', '/start', { provider: 'moneybird' });
    expect(response.statusCode).toBe(400);
  });

  it('answers 503 when Nango is down', async () => {
    const down = await createTestApp();
    try {
      const response = await down.inject({
        method: 'POST',
        url: '/api/connections/start',
        headers: { ...json, cookie: A.cookie },
        payload: { provider: 'outlook' },
      });
      expect(response.statusCode).toBe(503);
    } finally {
      await down.close();
    }
  });
});

describe('complete', () => {
  async function start(cookie: string) {
    const response = await call(cookie, 'POST', '/start', { provider: 'gmail' });
    return response.json().attemptId as string;
  }

  it('finds the connection at Nango by the attempt’s tag and hands it to the job', async () => {
    const attemptId = await start(A.cookie);
    nangoConnections = [
      { connectionId: 'other-integration', integrationId: 'outlook' },
      { connectionId: 'nango-conn-1', integrationId: 'gmail' },
    ];
    const response = await call(A.cookie, 'POST', '/complete', { attemptId });
    expect(response.json()).toEqual({ status: 'pending', failureCode: null, connectionId: null });
    const attempt = await withTenant(appDatabase.db, A.tenantId, (tx) =>
      getConnectAttempt(tx, attemptId),
    );
    expect(nangoCalls.at(-1)).toEqual({
      method: 'listConnectionsByTags',
      input: { connect_attempt: attempt?.nonce },
    });
    expect(enqueuedConnectAttempts).toEqual([
      { tenantId: A.tenantId, attemptId, nangoConnectionId: 'nango-conn-1' },
    ]);
  });

  it('stays pending without a Nango connection', async () => {
    const attemptId = await start(A.cookie);
    const response = await call(A.cookie, 'POST', '/complete', { attemptId });
    expect(response.json().status).toBe('pending');
    expect(enqueuedConnectAttempts).toHaveLength(0);
  });

  it('reports a finished attempt without asking Nango', async () => {
    const attemptId = await start(A.cookie);
    const connection = await seedConnection(A);
    await withTenant(appDatabase.db, A.tenantId, (tx) =>
      consumeConnectAttempt(tx, {
        attemptId,
        connectionId: connection.id,
        nangoConnectionId: connection.nangoConnectionId,
      }),
    );
    nangoCalls.length = 0;
    const response = await call(A.cookie, 'POST', '/complete', { attemptId });
    expect(response.json()).toEqual({
      status: 'connected',
      failureCode: null,
      connectionId: connection.id,
    });
    expect(nangoCalls).toHaveLength(0);
  });

  it('is NOT_FOUND for an attempt of another tenant or another member', async () => {
    const ofB = await start(B.cookie);
    const ofOwner = await start(A.cookie);
    nangoCalls.length = 0;
    expect((await call(A.cookie, 'POST', '/complete', { attemptId: ofB })).statusCode).toBe(404);
    expect((await call(memberCookie, 'POST', '/complete', { attemptId: ofOwner })).statusCode).toBe(
      404,
    );
    expect(
      (await call(A.cookie, 'POST', '/complete', { attemptId: randomUUID() })).statusCode,
    ).toBe(404);
    expect(nangoCalls).toHaveLength(0);
    expect(enqueuedConnectAttempts).toHaveLength(0);
  });
});

describe('reconnect', () => {
  it('creates a reconnect session for an own connection', async () => {
    const connection = await seedConnection(A);
    const response = await call(A.cookie, 'POST', '/reconnect', { connectionId: connection.id });
    expect(response.json()).toEqual({ sessionToken: 'reconnect-token' });
    expect(nangoCalls).toEqual([
      {
        method: 'createReconnectSession',
        input: {
          integrationId: 'gmail',
          connectionId: connection.nangoConnectionId,
          webhookUrlOverride: undefined,
        },
      },
    ]);
  });

  it('is NOT_FOUND for a connection of another tenant, FORBIDDEN for a member who did not connect it', async () => {
    const ofB = await seedConnection(B);
    const ofOwner = await seedConnection(A);
    expect((await call(A.cookie, 'POST', '/reconnect', { connectionId: ofB.id })).statusCode).toBe(
      404,
    );
    expect(
      (await call(memberCookie, 'POST', '/reconnect', { connectionId: ofOwner.id })).statusCode,
    ).toBe(403);
    expect(nangoCalls).toHaveLength(0);
  });
});

describe('disconnect', () => {
  it('revokes an own connection and enqueues its purge, once per call', async () => {
    const connection = await seedConnection(A);
    const response = await call(A.cookie, 'POST', '/disconnect', { connectionId: connection.id });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: connection.id, status: 'revoked' });
    expect(enqueuedPurges).toEqual([{ tenantId: A.tenantId, connectionId: connection.id }]);
    const after = await withTenant(appDatabase.db, A.tenantId, (tx) =>
      getConnection(tx, connection.id),
    );
    expect(after).toMatchObject({ status: 'revoked', statusReason: 'user_disconnected' });
  });

  it('is NOT_FOUND for another tenant and FORBIDDEN for a member who did not connect it', async () => {
    const ofB = await seedConnection(B);
    const ofOwner = await seedConnection(A);
    expect((await call(A.cookie, 'POST', '/disconnect', { connectionId: ofB.id })).statusCode).toBe(
      404,
    );
    expect(
      (await call(memberCookie, 'POST', '/disconnect', { connectionId: ofOwner.id })).statusCode,
    ).toBe(403);
    expect(enqueuedPurges).toHaveLength(0);
    const untouched = await withTenant(appDatabase.db, B.tenantId, (tx) =>
      getConnection(tx, ofB.id),
    );
    expect(untouched?.status).toBe('active');
  });
});
