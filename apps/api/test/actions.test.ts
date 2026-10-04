import { type Action, getAction, proposeAction, withTenant } from '@effectief/db';
import { agent, createTestCard, createTestConnection, quoteInput } from '@effectief/db/testing';
import { errorResponseSchema } from '@effectief/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  appDatabase,
  createTestApp,
  enqueuedExecutions,
  registerTenant,
  removeRegisteredTenants,
  testEnv,
} from './helpers.ts';

// actions.approve and actions.reject: only for a member of the tenant from the
// session; the action of another tenant does not exist for them.

const json = { 'content-type': 'application/json', origin: testEnv.APP_ORIGIN };

let app: FastifyInstance;
let a: Awaited<ReturnType<typeof registerTenant>>;
let b: Awaited<ReturnType<typeof registerTenant>>;

beforeAll(async () => {
  app = await createTestApp({ loginRateLimit: { max: 1000, timeWindow: '1 minute' } });
  a = await registerTenant(app, 'Installatiebedrijf A');
  b = await registerTenant(app, 'Hoveniersbedrijf B');
});
afterAll(async () => {
  await app.close();
  await removeRegisteredTenants();
});
beforeEach(() => {
  enqueuedExecutions.length = 0;
});

/** A concept quote in tenant A. */
function proposeQuote(): Promise<Action> {
  return withTenant(appDatabase.db, a.tenantId, async (tx) => {
    const connection = await createTestConnection(tx, a, 'moneybird');
    const card = await createTestCard(tx);
    const { action } = await proposeAction(tx, {
      cardId: card.id,
      connectionId: connection.id,
      type: 'moneybird.quote',
      input: quoteInput,
      actor: agent,
    });
    return action;
  });
}

const statusInA = async (actionId: string) =>
  (await withTenant(appDatabase.db, a.tenantId, (tx) => getAction(tx, actionId)))?.status;

const post = (path: string, cookie: string | undefined, payload: object) =>
  app.inject({
    method: 'POST',
    url: `/api/actions/${path}`,
    headers: cookie ? { ...json, cookie } : json,
    payload,
  });

describe('actions.approve', () => {
  it('approves for the member of the session and enqueues the execution', async () => {
    const action = await proposeQuote();
    const response = await post('approve', a.cookie, { actionId: action.id });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: action.id, status: 'approved' });
    expect(enqueuedExecutions).toMatchObject([{ tenantId: a.tenantId, actionId: action.id }]);

    const stored = await withTenant(appDatabase.db, a.tenantId, (tx) => getAction(tx, action.id));
    expect(stored).toMatchObject({ approvedByUserId: a.userId });
    expect(stored?.approvedAt).toBeInstanceOf(Date);
  });

  it('a second approval is a conflict and enqueues nothing', async () => {
    const action = await proposeQuote();
    await post('approve', a.cookie, { actionId: action.id });
    const again = await post('approve', a.cookie, { actionId: action.id });
    expect(again.statusCode).toBe(409);
    expect(errorResponseSchema.parse(again.json()).error.code).toBe('CONFLICT');
    expect(enqueuedExecutions).toHaveLength(1);
  });

  it('an edited input must fit the type of the action', async () => {
    const action = await proposeQuote();
    const response = await post('approve', a.cookie, {
      actionId: action.id,
      input: { ...quoteInput, lines: [] },
    });
    expect(response.statusCode).toBe(400);
    const body = errorResponseSchema.parse(response.json());
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.issues?.[0]?.path).toEqual(['input', 'lines']);
    expect(await statusInA(action.id)).toBe('concept');
  });

  it('needs a session', async () => {
    const action = await proposeQuote();
    const response = await post('approve', undefined, { actionId: action.id });
    expect(response.statusCode).toBe(401);
    expect(await statusInA(action.id)).toBe('concept');
  });
});

describe('actions.reject', () => {
  it('rejects a concept; it can no longer be approved', async () => {
    const action = await proposeQuote();
    const response = await post('reject', a.cookie, { actionId: action.id });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'rejected' });
    expect((await post('approve', a.cookie, { actionId: action.id })).statusCode).toBe(409);
    expect(enqueuedExecutions).toHaveLength(0);
  });
});

describe('tenant isolation', () => {
  it('tenant B can neither approve nor reject an action of tenant A', async () => {
    const action = await proposeQuote();
    for (const path of ['approve', 'reject']) {
      // A tenantId in the body is not part of the contract and is ignored.
      const response = await post(path, b.cookie, { actionId: action.id, tenantId: a.tenantId });
      expect(response.statusCode).toBe(404);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
    }
    expect(await statusInA(action.id)).toBe('concept');
    expect(enqueuedExecutions).toHaveLength(0);
  });
});
