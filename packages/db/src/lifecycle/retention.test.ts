import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAction, rejectAction } from '../feed/actions.ts';
import { getCard, getCardLinks, linkCard, transitionCard } from '../feed/cards.ts';
import { asUser, seedFeed, system } from '../feed/test-fixtures.ts';
import {
  getEvent,
  getEventContent,
  linkEventEntity,
  recordEvent,
  setEventSummary,
} from '../memory/events.ts';
import { auditLog, eventEntities } from '../schema/index.ts';
import { openTestDatabases, type TestTenant } from '../test-support.ts';
import { type TenantTransaction, withTenant } from '../with-tenant.ts';
import { listTenantIds, purgeExpiredBatch, retentionCutoff } from './retention.ts';

// Retention (#037): source content goes after the tenant's period, the
// timeline keeps its summary and references. Runs as app_runtime.

const db = openTestDatabases();
let tenant: TestTenant;
let other: TestTenant;
const DAY_MS = 24 * 60 * 60 * 1000;

const inTenant = <T>(fn: (tx: TenantTransaction) => Promise<T>) =>
  withTenant(db.app.db, tenant.tenantId, fn);

beforeAll(async () => {
  tenant = await db.createTenant();
  other = await db.createTenant();
});
afterAll(() => db.close());

/** A mail with content, a summary and links, `ageDays` ago (default period: 90 days). */
async function seedMail(tx: TenantTransaction, owner: TestTenant, ageDays: number) {
  const world = await seedFeed(tx, owner);
  const { event } = await recordEvent(tx, {
    event: {
      source: 'gmail',
      externalId: `message-${randomUUID()}`,
      type: 'email.received',
      occurredAt: new Date(Date.now() - ageDays * DAY_MS),
      connectionId: world.connection.id,
      payload: { attachmentCount: 1 },
    },
    content: {
      fromAddress: 'jan@example.test',
      subject: 'Offerte',
      bodyText: 'Beste, kunt u een offerte sturen?',
    },
  });
  await setEventSummary(tx, event.id, 'Jan vraagt een offerte');
  await linkEventEntity(tx, {
    eventId: event.id,
    entityId: world.contact.id,
    role: 'sender',
    linkedBy: 'rule',
  });
  await linkCard(tx, { cardId: world.card.id, eventIds: [event.id] });
  return { ...world, event };
}

const retentionAudit = (tx: TenantTransaction) =>
  tx.select().from(auditLog).where(eq(auditLog.action, 'retention.purged'));

describe('event contents', () => {
  it('deletes expired content and keeps summary, payload and references', async () => {
    const { expired, fresh } = await inTenant(async (tx) => ({
      expired: await seedMail(tx, tenant, 100),
      fresh: await seedMail(tx, tenant, 10),
    }));
    // Expired content of another tenant is not touched by this tenant's run.
    const foreign = await withTenant(db.app.db, other.tenantId, (tx) => seedMail(tx, other, 100));

    const count = await inTenant((tx) =>
      purgeExpiredBatch(tx, { step: 'event_contents', now: new Date() }),
    );
    expect(count).toBe(1);

    const after = await inTenant(async (tx) => ({
      expiredContent: await getEventContent(tx, expired.event.id),
      expiredEvent: await getEvent(tx, expired.event.id),
      freshContent: await getEventContent(tx, fresh.event.id),
      links: await getCardLinks(tx, expired.card.id),
      audit: await retentionAudit(tx),
    }));
    expect(after.expiredContent).toBeUndefined();
    expect(after.expiredEvent).toMatchObject({
      summary: 'Jan vraagt een offerte',
      externalId: expired.event.externalId,
      connectionId: expired.connection.id,
      payload: { attachmentCount: 1 },
    });
    expect(after.freshContent?.bodyText).toBe('Beste, kunt u een offerte sturen?');
    // The card still points to its event; the event still to its contact.
    expect(after.links.eventIds).toContain(expired.event.id);
    const linked = await inTenant((tx) =>
      tx
        .select()
        .from(eventEntities)
        .where(
          and(
            eq(eventEntities.eventId, expired.event.id),
            eq(eventEntities.entityId, expired.contact.id),
          ),
        ),
    );
    expect(linked).toHaveLength(1);
    expect(after.audit).toMatchObject([
      {
        actorType: 'system',
        objectType: 'event_contents',
        objectId: null,
        metadata: { step: 'event_contents', count: 1 },
      },
    ]);

    const foreignContent = await withTenant(db.app.db, other.tenantId, (tx) =>
      getEventContent(tx, foreign.event.id),
    );
    expect(foreignContent).toBeDefined();
  });

  it('works in batches and is idempotent', async () => {
    await inTenant(async (tx) => {
      await seedMail(tx, tenant, 200);
      await seedMail(tx, tenant, 200);
      await seedMail(tx, tenant, 200);
    });
    const now = new Date();
    const run = () =>
      inTenant((tx) => purgeExpiredBatch(tx, { step: 'event_contents', now, limit: 2 }));
    expect(await run()).toBe(2);
    expect(await run()).toBe(1);
    expect(await run()).toBe(0);
  });
});

describe('action inputs', () => {
  it('clears the inputs of an action finished longer than 180 days ago', async () => {
    const { finished, open } = await inTenant(async (tx) => {
      const a = await seedFeed(tx, tenant);
      await rejectAction(tx, { actionId: a.action.id, actor: asUser(tenant.userId) });
      const b = await seedFeed(tx, tenant);
      return { finished: a.action, open: b.action };
    });
    const now = new Date(Date.now() + 181 * DAY_MS);
    expect(retentionCutoff('action_inputs', now).getTime()).toBeGreaterThan(Date.now());

    const count = await inTenant((tx) => purgeExpiredBatch(tx, { step: 'action_inputs', now }));
    expect(count).toBeGreaterThanOrEqual(1);
    const after = await inTenant(async (tx) => ({
      finished: await getAction(tx, finished.id),
      open: await getAction(tx, open.id),
    }));
    expect(after.finished).toMatchObject({
      status: 'rejected',
      proposedInput: null,
      input: null,
      idempotencyKey: finished.idempotencyKey,
    });
    expect(after.finished?.inputPurgedAt).toBeInstanceOf(Date);
    // A concept still waits for the user: its input stays.
    expect(after.open?.input).toEqual(open.input);
  });

  it('keeps the inputs of an action finished recently', async () => {
    const action = await inTenant(async (tx) => {
      const world = await seedFeed(tx, tenant);
      await rejectAction(tx, { actionId: world.action.id, actor: asUser(tenant.userId) });
      return world.action;
    });
    await inTenant((tx) => purgeExpiredBatch(tx, { step: 'action_inputs', now: new Date() }));
    const after = await inTenant((tx) => getAction(tx, action.id));
    expect(after?.input).toEqual(action.input);
  });
});

describe('closed cards', () => {
  it('deletes cards closed longer than 12 months ago, with their actions', async () => {
    const { closed, open } = await inTenant(async (tx) => {
      const a = await seedFeed(tx, tenant);
      await transitionCard(tx, { cardId: a.card.id, from: 'open', to: 'done', actor: system });
      const b = await seedFeed(tx, tenant);
      return { closed: a, open: b };
    });
    const now = new Date(Date.now() + 366 * DAY_MS);
    await inTenant((tx) => purgeExpiredBatch(tx, { step: 'closed_cards', now }));

    const after = await inTenant(async (tx) => ({
      closedCard: await getCard(tx, closed.card.id),
      closedAction: await getAction(tx, closed.action.id),
      closedEvent: await getEvent(tx, closed.event.id),
      openCard: await getCard(tx, open.card.id),
    }));
    expect(after.closedCard).toBeUndefined();
    expect(after.closedAction).toBeUndefined();
    // The timeline is not part of a card; its event stays.
    expect(after.closedEvent).toBeDefined();
    expect(after.openCard?.status).toBe('open');
  });
});

describe('list_tenant_ids()', () => {
  it('gives the app role the ids of all tenants, and nothing else', async () => {
    const ids = await listTenantIds(db.app.db);
    expect(ids).toEqual(expect.arrayContaining([tenant.tenantId, other.tenantId]));
  });

  it('only app_runtime may execute it', async () => {
    await expect(db.authPool.query('select * from public.list_tenant_ids()')).rejects.toMatchObject(
      {
        code: '42501',
      },
    );
  });
});
