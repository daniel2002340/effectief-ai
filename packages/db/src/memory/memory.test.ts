import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { checkViolation, openTestDatabases, type TestTenant } from '../test-support.ts';
import { withTenant } from '../with-tenant.ts';
import {
  addEntityIdentifier,
  createEntity,
  findEntityByIdentifier,
  listEntityIdentifiers,
} from './entities.ts';
import { getEventContent, linkEventEntity, listTimeline, recordEvent } from './events.ts';
import { createRelation, listRelations } from './relations.ts';
import { createTask, listTasks } from './tasks.ts';

const db = openTestDatabases();
let tenant: TestTenant;

const asTenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(db.app.db, tenant.tenantId, fn);

beforeAll(async () => {
  tenant = await db.createTenant();
});
afterAll(() => db.close());

const DAY_MS = 24 * 60 * 60 * 1000;

const mail = (externalId: string, occurredAt = new Date()) => ({
  source: 'gmail' as const,
  externalId,
  type: 'email.received' as const,
  occurredAt,
  threadKey: 'thread-1',
  payload: { attachmentCount: 1 },
});

describe('recordEvent', () => {
  it('stores one row for a repeated (source, external_id) and keeps the first content', async () => {
    const first = await asTenant((tx) =>
      recordEvent(tx, { event: mail('dup-1'), content: { bodyText: 'Eerste' } }),
    );
    const second = await asTenant((tx) =>
      recordEvent(tx, { event: mail('dup-1'), content: { bodyText: 'Tweede' } }),
    );
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, event: { id: first.event.id } });

    const count = await asTenant((tx) =>
      tx.execute(sql`select count(*)::int as n from events where external_id = 'dup-1'`),
    );
    expect(count.rows).toEqual([{ n: 1 }]);
    const content = await asTenant((tx) => getEventContent(tx, first.event.id));
    expect(content?.bodyText).toBe('Eerste');
  });

  it('stores one row when the same event arrives concurrently', async () => {
    const results = await Promise.all(
      [1, 2, 3].map(() => asTenant((tx) => recordEvent(tx, { event: mail('race-1') }))),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.event.id)).size).toBe(1);
  });

  it('the same external id from another source is another event', async () => {
    const gmail = await asTenant((tx) => recordEvent(tx, { event: mail('shared-id') }));
    const outlook = await asTenant((tx) =>
      recordEvent(tx, { event: { ...mail('shared-id'), source: 'outlook' } }),
    );
    expect(outlook.created).toBe(true);
    expect(outlook.event.id).not.toBe(gmail.event.id);
  });

  it('keeps content until occurred_at plus the tenant retention period', async () => {
    const occurredAt = new Date('2026-09-01T08:00:00Z');
    await asTenant((tx) => tx.execute(sql`update tenant_settings set content_retention_days = 30`));
    const { event } = await asTenant((tx) =>
      recordEvent(tx, { event: mail('retain-1', occurredAt), content: { subject: 'Vraag' } }),
    );
    const content = await asTenant((tx) => getEventContent(tx, event.id));
    expect(content?.retainUntil).toEqual(new Date(occurredAt.getTime() + 30 * DAY_MS));
    await asTenant((tx) => tx.execute(sql`update tenant_settings set content_retention_days = 90`));
  });

  it('gives events a UUIDv7 from the database', async () => {
    const before = Date.now();
    const { event } = await asTenant((tx) => recordEvent(tx, { event: mail('uuid-1') }));
    expect(event.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const millis = Number.parseInt(event.id.replaceAll('-', '').slice(0, 12), 16);
    expect(millis).toBeGreaterThanOrEqual(before - 1000);
    expect(millis).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('timeline and links', () => {
  it('lists events of one entity, newest first', async () => {
    const result = await asTenant(async (tx) => {
      const klant = await createEntity(tx, { type: 'contact', name: 'Klaas' });
      const older = await recordEvent(tx, { event: mail('tl-1', new Date('2026-09-01')) });
      const newer = await recordEvent(tx, { event: mail('tl-2', new Date('2026-09-02')) });
      await recordEvent(tx, { event: mail('tl-3', new Date('2026-09-03')) });
      for (const { event } of [older, newer]) {
        await linkEventEntity(tx, {
          eventId: event.id,
          entityId: klant.id,
          role: 'sender',
          linkedBy: 'rule',
        });
      }
      // A second role on the same event must not duplicate it in the timeline.
      await linkEventEntity(tx, {
        eventId: newer.event.id,
        entityId: klant.id,
        role: 'mentioned',
        linkedBy: 'ai',
      });
      const timeline = await listTimeline(tx, { entityId: klant.id });
      return { timeline, expected: [newer.event.id, older.event.id] };
    });
    expect(result.timeline.map((e) => e.id)).toEqual(result.expected);
  });
});

describe('entities, identifiers and relations', () => {
  it('normalises identifiers and finds the entity by them', async () => {
    const { entity, found, identifiers } = await asTenant(async (tx) => {
      const entity = await createEntity(tx, {
        type: 'contact',
        name: 'Anna de Vries',
        attributes: { jobTitle: 'Inkoper' },
      });
      await addEntityIdentifier(tx, {
        entityId: entity.id,
        identifier: { kind: 'email', value: '  Anna@Hovenier-DeVries.NL ' },
        source: { sourceType: 'user', sourceUserId: tenant.userId },
      });
      await addEntityIdentifier(tx, {
        entityId: entity.id,
        identifier: { kind: 'phone', value: '06-123 456 78' },
        source: { sourceType: 'system' },
      });
      const found = await findEntityByIdentifier(tx, {
        kind: 'email',
        value: 'anna@hovenier-devries.nl',
      });
      return { entity, found, identifiers: await listEntityIdentifiers(tx, entity.id) };
    });
    expect(found?.id).toBe(entity.id);
    expect(identifiers.map((i) => i.value).sort()).toEqual([
      '+31612345678',
      'anna@hovenier-devries.nl',
    ]);
  });

  it('returns the existing identifier when the value is already taken', async () => {
    const result = await asTenant(async (tx) => {
      const first = await createEntity(tx, { type: 'company', name: 'Schoon BV' });
      const second = await createEntity(tx, { type: 'company', name: 'Schoon B.V.' });
      const identifier = { kind: 'kvk', value: '11223344' } as const;
      await addEntityIdentifier(tx, {
        entityId: first.id,
        identifier,
        source: { sourceType: 'system' },
      });
      const again = await addEntityIdentifier(tx, {
        entityId: second.id,
        identifier,
        source: { sourceType: 'system' },
      });
      return { again, firstId: first.id };
    });
    expect(result.again).toMatchObject({
      created: false,
      identifier: { entityId: result.firstId },
    });
  });

  it('creates relations as proposed and lists them from both sides', async () => {
    const result = await asTenant(async (tx) => {
      const person = await createEntity(tx, { type: 'contact', name: 'Sem' });
      const company = await createEntity(tx, { type: 'company', name: 'Licht BV' });
      const relation = await createRelation(tx, {
        fromEntityId: person.id,
        toEntityId: company.id,
        type: 'works_at',
        source: { sourceType: 'system', aiModel: 'classifier-v1' },
      });
      return { relation, fromCompany: await listRelations(tx, company.id) };
    });
    expect(result.relation).toMatchObject({ status: 'proposed', sourceType: 'system' });
    expect(result.fromCompany.map((r) => r.id)).toEqual([result.relation.id]);
  });

  it('creates tasks with their entities', async () => {
    const result = await asTenant(async (tx) => {
      const entity = await createEntity(tx, { type: 'project', name: 'Warmtepomp Dorpsstraat' });
      const { task, entityIds } = await createTask(tx, {
        title: 'Offerte nabellen',
        dueAt: new Date('2026-10-09T08:00:00Z'),
        createdBy: 'user',
        assigneeUserId: tenant.userId,
        entityIds: [entity.id, entity.id],
        source: { sourceType: 'user', sourceUserId: tenant.userId },
      });
      return { task, entityIds, open: await listTasks(tx) };
    });
    expect(result.task.status).toBe('open');
    expect(result.entityIds).toHaveLength(1);
    expect(result.open.map((t) => t.id)).toContain(result.task.id);
  });
});

describe('jsonb with invalid content is rejected', () => {
  const rejectsZod = (promise: Promise<unknown>) =>
    expect(promise).rejects.toBeInstanceOf(ZodError);

  it('by the Zod schema in the repository', async () => {
    await asTenant(async (tx) => {
      await rejectsZod(
        createEntity(tx, {
          type: 'contact',
          name: 'X',
          // @ts-expect-error: e-mail belongs in entity_identifiers, not in attributes
          attributes: { email: 'x@example.nl' },
        }),
      );
      await rejectsZod(
        createEntity(tx, {
          type: 'company',
          name: 'X',
          attributes: { website: 'javascript:alert(1)' },
        }),
      );
      await rejectsZod(
        recordEvent(tx, {
          event: {
            source: 'app',
            externalId: 'bad-1',
            type: 'note.added',
            occurredAt: new Date(),
            // @ts-expect-error: no free text in event payloads
            payload: { text: 'Bel Jan op 0612345678' },
          },
        }),
      );
      await rejectsZod(
        recordEvent(tx, {
          event: {
            source: 'moneybird',
            externalId: 'bad-2',
            type: 'quote.sent',
            occurredAt: new Date(),
            payload: {
              providerObjectId: '123',
              totalExclVatCents: 1200.5,
              vatRateBps: 2100,
            },
          },
        }),
      );
      await rejectsZod(
        recordEvent(tx, {
          event: { ...mail('bad-3'), payload: { attachmentCount: -1 } },
          content: {
            // @ts-expect-error: attachments are metadata objects
            attachments: ['factuur.pdf'],
          },
        }),
      );
    });
  });

  it('by the source reference schema', async () => {
    await asTenant(async (tx) => {
      const entity = await createEntity(tx, { type: 'contact', name: 'Bron' });
      await rejectsZod(
        addEntityIdentifier(tx, {
          entityId: entity.id,
          identifier: { kind: 'email_domain', value: 'gmail.com' },
          source: { sourceType: 'system' },
        }),
      );
      await rejectsZod(
        createTask(tx, {
          title: 'X',
          createdBy: 'ai',
          // @ts-expect-error: an event source needs sourceEventId
          source: { sourceType: 'event' },
        }),
      );
      await rejectsZod(
        createTask(tx, {
          title: 'X',
          createdBy: 'ai',
          // @ts-expect-error: a document source needs sourceChunkId
          source: { sourceType: 'document', sourceEventId: entity.id },
        }),
      );
    });
  });

  it.each([
    [
      'entities.attributes as array',
      sql`insert into entities (type, name, attributes) values ('contact', 'X', '[]')`,
    ],
    [
      'entities.attributes as string',
      sql`insert into entities (type, name, attributes) values ('contact', 'X', '"x"')`,
    ],
    [
      'events.payload as array',
      sql`insert into events (source, external_id, type, occurred_at, payload) values ('app', 'raw-1', 'note.added', now(), '[1]')`,
    ],
    [
      'entities.type outside the list',
      sql`insert into entities (type, name, attributes) values ('person', 'X', '{}')`,
    ],
    [
      'events.type outside the list',
      sql`insert into events (source, external_id, type, occurred_at, payload) values ('app', 'raw-2', 'email.deleted', now(), '{}')`,
    ],
  ])('by the database check (%s)', async (_name, statement) => {
    await expect(asTenant((tx) => tx.execute(statement))).rejects.toMatchObject(checkViolation);
  });

  it('by the database check (event_contents.attachments as object)', async () => {
    const { event } = await asTenant((tx) => recordEvent(tx, { event: mail('raw-3') }));
    await expect(
      asTenant((tx) =>
        tx.execute(
          sql`insert into event_contents (event_id, retain_until, attachments) values (${event.id}, now(), '{}')`,
        ),
      ),
    ).rejects.toMatchObject(checkViolation);
  });
});
