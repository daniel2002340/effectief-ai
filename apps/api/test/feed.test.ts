import { randomUUID } from 'node:crypto';
import {
  linkCard,
  linkEventEntity,
  recordEvent,
  setEventSummary,
  type TenantTransaction,
  transitionCard,
  withTenant,
} from '@effectief/db';
import { seedFeed, system } from '@effectief/db/testing';
import { type CardDetail, type EntityDetail, errorResponseSchema } from '@effectief/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appDatabase,
  createTestApp,
  registerTenant,
  removeRegisteredTenants,
  testEnv,
} from './helpers.ts';

// cards.list, cards.get and entities.get: a session is required, and a
// session only ever sees the data of its own tenant.

/** A response body as JSON: dates are ISO strings. */
type Json<T> = { [K in keyof T]: T[K] extends Date | null ? string | null : Json<T[K]> };

const json = { 'content-type': 'application/json', origin: testEnv.APP_ORIGIN };

let app: FastifyInstance;
let a: Awaited<ReturnType<typeof registerTenant>>;
let b: Awaited<ReturnType<typeof registerTenant>>;
let worldA: Awaited<ReturnType<typeof seedWorld>>;
let worldB: Awaited<ReturnType<typeof seedWorld>>;

/** The feed fixture plus an older mail with source content and a summary. */
async function seedWorld(tx: TenantTransaction, tenant: { tenantId: string; userId: string }) {
  const world = await seedFeed(tx, tenant);
  const { event: older } = await recordEvent(tx, {
    event: {
      source: 'gmail',
      externalId: `message-${randomUUID()}`,
      type: 'email.received',
      occurredAt: new Date(Date.now() - 60_000),
      connectionId: world.connection.id,
      payload: {},
    },
    content: { fromAddress: 'jan@example.test', bodyText: 'Geheime inhoud van de mail' },
  });
  await setEventSummary(tx, older.id, 'Jan vraagt een offerte');
  await linkEventEntity(tx, {
    eventId: older.id,
    entityId: world.contact.id,
    role: 'sender',
    linkedBy: 'rule',
  });
  await linkEventEntity(tx, {
    eventId: world.event.id,
    entityId: world.contact.id,
    role: 'sender',
    linkedBy: 'rule',
  });
  await linkCard(tx, { cardId: world.card.id, eventIds: [older.id] });
  const snoozed = await seedFeed(tx, tenant);
  await transitionCard(tx, {
    cardId: snoozed.card.id,
    from: 'open',
    to: 'snoozed',
    snoozedUntil: new Date(Date.now() + 86_400_000),
    actor: system,
  });
  return { ...world, older, snoozed };
}

beforeAll(async () => {
  app = await createTestApp({ loginRateLimit: { max: 1000, timeWindow: '1 minute' } });
  a = await registerTenant(app, 'Installatiebedrijf A');
  b = await registerTenant(app, 'Hoveniersbedrijf B');
  worldA = await withTenant(appDatabase.db, a.tenantId, (tx) => seedWorld(tx, a));
  worldB = await withTenant(appDatabase.db, b.tenantId, (tx) => seedWorld(tx, b));
});
afterAll(async () => {
  await app.close();
  await removeRegisteredTenants();
});

const get = (url: string, cookie?: string) =>
  app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

describe('every procedure needs a session', () => {
  it.each([
    ['GET', '/api/cards'],
    ['GET', '/api/cards/00000000-0000-4000-8000-000000000001'],
    ['GET', '/api/entities/00000000-0000-4000-8000-000000000001'],
    ['POST', '/api/actions/approve'],
    ['POST', '/api/actions/reject'],
  ] as const)('%s %s without a session: 401', async (method, url) => {
    const response = await app.inject({
      method,
      url,
      headers: json,
      ...(method === 'POST' ? { payload: { actionId: worldA.action.id } } : {}),
    });
    expect(response.statusCode).toBe(401);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('UNAUTHORIZED');
  });

  it('a forged or expired session cookie is no session', async () => {
    const response = await get('/api/cards', 'better-auth.session_token=forged.value');
    expect(response.statusCode).toBe(401);
  });
});

describe('cards.list', () => {
  it('lists the open cards of the own tenant only', async () => {
    const response = await get('/api/cards', a.cookie);
    expect(response.statusCode).toBe(200);
    const cards = response.json<{ id: string; status: string }[]>();
    const ids = cards.map((card) => card.id);
    expect(ids).toContain(worldA.card.id);
    expect(ids).not.toContain(worldA.snoozed.card.id);
    expect(ids).not.toContain(worldB.card.id);
    expect(cards.every((card) => card.status === 'open')).toBe(true);
  });

  it('filters on snoozed and limits', async () => {
    const snoozed = await get('/api/cards?status=snoozed', a.cookie);
    expect(snoozed.json<{ id: string }[]>().map((c) => c.id)).toEqual([worldA.snoozed.card.id]);
    const limited = await get('/api/cards?limit=1', a.cookie);
    expect(limited.json()).toHaveLength(1);
    expect((await get('/api/cards?status=done', a.cookie)).statusCode).toBe(400);
  });
});

describe('cards.get', () => {
  it('returns the card with its events, entities and actions, without source content', async () => {
    const response = await get(`/api/cards/${worldA.card.id}`, a.cookie);
    expect(response.statusCode).toBe(200);
    const card = response.json<Json<CardDetail>>();
    expect(card).toMatchObject({ id: worldA.card.id, kind: 'email_reply', status: 'open' });
    expect(card.events.map((e) => e.id)).toEqual([worldA.event.id, worldA.older.id]);
    expect(card.events[1]?.summary).toBe('Jan vraagt een offerte');
    expect(card.entities).toEqual([{ id: worldA.contact.id, type: 'contact', name: 'Jan Jansen' }]);
    expect(card.actions).toMatchObject([
      { id: worldA.action.id, type: 'email.reply', status: 'concept', input: worldA.action.input },
    ]);
    expect(response.body).not.toContain('Geheime inhoud');
  });

  it('the card of another tenant does not exist', async () => {
    const response = await get(`/api/cards/${worldA.card.id}`, b.cookie);
    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
  });

  it('an id that is not a uuid is refused', async () => {
    expect((await get('/api/cards/not-a-uuid', a.cookie)).statusCode).toBe(400);
  });
});

describe('entities.get', () => {
  it('returns the entity with identifiers and its timeline, newest first', async () => {
    const response = await get(`/api/entities/${worldA.contact.id}`, a.cookie);
    expect(response.statusCode).toBe(200);
    const entity = response.json<Json<EntityDetail>>();
    expect(entity).toMatchObject({ id: worldA.contact.id, name: 'Jan Jansen', type: 'contact' });
    expect(entity.timeline.map((e) => e.id)).toEqual([worldA.event.id, worldA.older.id]);
    expect(response.body).not.toContain('Geheime inhoud');
  });

  it('pages the timeline with before', async () => {
    const newest = worldA.event.occurredAt.toISOString();
    const response = await get(
      `/api/entities/${worldA.contact.id}?before=${encodeURIComponent(newest)}`,
      a.cookie,
    );
    const entity = response.json<Json<EntityDetail>>();
    expect(entity.timeline.map((e) => e.id)).toEqual([worldA.older.id]);
  });

  it('the entity of another tenant does not exist', async () => {
    const response = await get(`/api/entities/${worldA.contact.id}`, b.cookie);
    expect(response.statusCode).toBe(404);
    const own = await get(`/api/entities/${worldB.contact.id}`, b.cookie);
    expect(own.statusCode).toBe(200);
  });
});
