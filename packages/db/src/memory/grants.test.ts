import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkViolation,
  openTestDatabases,
  permissionDenied,
  type TestTenant,
} from '../test-support.ts';
import { withTenant } from '../with-tenant.ts';
import { addEntityIdentifier, createEntity } from './entities.ts';
import { linkEventEntity, recordEvent, setEventSummary } from './events.ts';
import { createRelation } from './relations.ts';
import { createTask } from './tasks.ts';

// The privileges of app_runtime must match docs/data-model.md §5 exactly, so
// the document and the database cannot drift apart. Append-only and immutable
// tables reject changes from the app role.

type Privilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

interface Expected {
  table: Privilege[];
  /** Column-level UPDATE; only when the table has no table-level UPDATE. */
  updateColumns?: string[];
}

/** docs/data-model.md §5, for every table with a tenant_id built so far. */
const expectedGrants: Record<string, Expected> = {
  tenant_settings: { table: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  entities: {
    table: ['SELECT', 'INSERT', 'DELETE'],
    updateColumns: ['name', 'attributes', 'archived_at', 'merged_into_id', 'updated_at'],
  },
  entity_identifiers: { table: ['SELECT', 'INSERT', 'DELETE'] },
  relations: {
    table: ['SELECT', 'INSERT'],
    updateColumns: ['status', 'valid_to', 'confirmed_by_user_id', 'confirmed_at', 'updated_at'],
  },
  events: { table: ['SELECT', 'INSERT', 'DELETE'], updateColumns: ['summary', 'summarized_at'] },
  event_contents: { table: ['SELECT', 'INSERT', 'DELETE'] },
  event_entities: { table: ['SELECT', 'INSERT', 'DELETE'] },
  tasks: {
    table: ['SELECT', 'INSERT', 'DELETE'],
    updateColumns: [
      'title',
      'notes',
      'due_at',
      'status',
      'assignee_user_id',
      'completed_at',
      'completed_by_user_id',
      'updated_at',
    ],
  },
  task_entities: { table: ['SELECT', 'INSERT', 'DELETE'] },
  connections: {
    table: ['SELECT', 'INSERT'],
    updateColumns: [
      'status',
      'status_reason',
      'status_changed_at',
      'last_synced_at',
      'account_label',
      'external_account_id',
      'updated_at',
    ],
  },
  entity_external_refs: { table: ['SELECT', 'INSERT', 'DELETE'] },
  cards: {
    table: ['SELECT', 'INSERT', 'DELETE'],
    updateColumns: [
      'status',
      'title',
      'summary',
      'payload',
      'priority',
      'snoozed_until',
      'resolved_at',
      'resolved_by_user_id',
      'updated_at',
    ],
  },
  card_events: { table: ['SELECT', 'INSERT', 'DELETE'] },
  card_entities: { table: ['SELECT', 'INSERT', 'DELETE'] },
  actions: {
    table: ['SELECT', 'INSERT'],
    updateColumns: [
      'status',
      'proposed_input',
      'input',
      'input_purged_at',
      'provider_object_id',
      'result',
      'approved_by_user_id',
      'approved_at',
      'executed_at',
      'attempts',
      'last_error_code',
      'updated_at',
    ],
  },
  audit_log: { table: ['SELECT', 'INSERT'] },
  facts: {
    table: ['SELECT', 'INSERT'],
    updateColumns: [
      'status',
      'valid_to',
      'superseded_by_id',
      'confirmed_by_user_id',
      'confirmed_at',
      'last_confirmed_at',
      'updated_at',
    ],
  },
  playbooks: {
    table: ['SELECT', 'INSERT'],
    updateColumns: ['status', 'confirmed_by_user_id', 'confirmed_at', 'updated_at'],
  },
  playbook_examples: { table: ['SELECT', 'INSERT', 'DELETE'] },
  documents: {
    table: ['SELECT', 'INSERT', 'DELETE'],
    updateColumns: ['status', 'title', 'updated_at'],
  },
  document_chunks: { table: ['SELECT', 'INSERT'] },
  document_entities: { table: ['SELECT', 'INSERT', 'DELETE'] },
  fact_embeddings: { table: ['SELECT', 'INSERT', 'DELETE'] },
  playbook_embeddings: { table: ['SELECT', 'INSERT', 'DELETE'] },
  chunk_embeddings: { table: ['SELECT', 'INSERT', 'DELETE'] },
  company_profile: { table: ['SELECT', 'INSERT', 'UPDATE'] },
  insights: { table: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
};

const db = openTestDatabases();
afterAll(() => db.close());

describe('privileges of app_runtime', () => {
  it('match docs/data-model.md §5 for every tenant table', async () => {
    const { rows } = await db.app.db.execute<{
      table_name: string;
      privileges: Privilege[];
      update_columns: string[];
    }>(sql`
      select c.relname as table_name,
             array(select p from unnest(array['SELECT','INSERT','UPDATE','DELETE']) p
                    where has_table_privilege('app_runtime', c.oid, p) order by p) as privileges,
             array(select a.attname::text from pg_attribute a
                    where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                      and has_column_privilege('app_runtime', c.oid, a.attnum, 'UPDATE')
                      and not has_table_privilege('app_runtime', c.oid, 'UPDATE')
                    order by a.attname) as update_columns
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p')
         and exists (select from pg_attribute a
                      where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
    `);

    const actual = Object.fromEntries(
      rows.map((row) => [row.table_name, { table: row.privileges, update: row.update_columns }]),
    );
    const expected = Object.fromEntries(
      Object.entries(expectedGrants).map(([table, grants]) => [
        table,
        { table: [...grants.table].sort(), update: [...(grants.updateColumns ?? [])].sort() },
      ]),
    );
    expect(actual).toEqual(expected);
  });
});

describe('append-only and immutable tables', () => {
  let tenant: TestTenant;
  let ids: { eventId: string; contactId: string; companyId: string; taskId: string };

  const asTenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(db.app.db, tenant.tenantId, fn);

  beforeAll(async () => {
    tenant = await db.createTenant();
    ids = await asTenant(async (tx) => {
      const contact = await createEntity(tx, { type: 'contact', name: 'Piet' });
      const company = await createEntity(tx, { type: 'company', name: 'Tuin BV' });
      await addEntityIdentifier(tx, {
        entityId: contact.id,
        identifier: { kind: 'phone', value: '06 12345678' },
        source: { sourceType: 'system' },
      });
      const { event } = await recordEvent(tx, {
        event: {
          source: 'gmail',
          externalId: 'm-1',
          type: 'email.received',
          occurredAt: new Date(),
          payload: { attachmentCount: 0 },
        },
        content: { subject: 'Snoeien', bodyText: 'Wanneer kunt u komen?' },
      });
      await linkEventEntity(tx, {
        eventId: event.id,
        entityId: contact.id,
        role: 'sender',
        linkedBy: 'rule',
      });
      await createRelation(tx, {
        fromEntityId: contact.id,
        toEntityId: company.id,
        type: 'works_at',
        source: { sourceType: 'event', sourceEventId: event.id },
      });
      const { task } = await createTask(tx, {
        title: 'Piet bellen',
        createdBy: 'user',
        entityIds: [contact.id],
        source: { sourceType: 'system' },
      });
      return { eventId: event.id, contactId: contact.id, companyId: company.id, taskId: task.id };
    });
  });

  it.each([
    ['source', `'app'`],
    ['external_id', `'other'`],
    ['type', `'note.added'`],
    ['occurred_at', 'now()'],
    ['thread_key', `'t'`],
    ['payload', `'{}'::jsonb`],
    ['created_at', 'now()'],
    ['tenant_id', 'tenant_id'],
  ])('events.%s cannot be changed', async (column, value) => {
    await expect(
      asTenant((tx) =>
        tx.execute(
          sql`update events set ${sql.identifier(column)} = ${sql.raw(value)} where id = ${ids.eventId}`,
        ),
      ),
    ).rejects.toMatchObject(permissionDenied);
  });

  it('events.summary can be set once, never changed', async () => {
    expect(await asTenant((tx) => setEventSummary(tx, ids.eventId, 'Vraagt om snoeiwerk'))).toBe(
      true,
    );
    expect(await asTenant((tx) => setEventSummary(tx, ids.eventId, 'Iets anders'))).toBe(false);
    await expect(
      asTenant((tx) =>
        tx.execute(sql`update events set summary = 'Overschreven' where id = ${ids.eventId}`),
      ),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23000' }) });
    await expect(
      asTenant((tx) =>
        tx.execute(
          sql`update events set summary = null, summarized_at = null where id = ${ids.eventId}`,
        ),
      ),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23000' }) });
  });

  it('summary and summarized_at are set together', async () => {
    const { event } = await asTenant((tx) =>
      recordEvent(tx, {
        event: {
          source: 'app',
          externalId: 'note-1',
          type: 'note.added',
          occurredAt: new Date(),
          payload: {},
        },
      }),
    );
    await expect(
      asTenant((tx) => tx.execute(sql`update events set summary = 'x' where id = ${event.id}`)),
    ).rejects.toMatchObject(checkViolation);
  });

  it.each([
    ['event_contents', 'body_text', `'anders'`],
    ['event_contents', 'retain_until', `now() + interval '10 years'`],
    ['entity_identifiers', 'value', `'+31600000000'`],
    ['event_entities', 'role', `'mentioned'`],
    ['task_entities', 'entity_id', 'entity_id'],
    ['relations', 'type', `'client_of'`],
    ['relations', 'from_entity_id', 'to_entity_id'],
    ['relations', 'valid_from', 'now()'],
    ['relations', 'source_type', `'user'`],
    ['entities', 'type', `'company'`],
    ['tasks', 'created_by', `'ai'`],
    ['tasks', 'source_event_id', 'null'],
  ])('%s.%s cannot be changed', async (table, column, value) => {
    await expect(
      asTenant((tx) =>
        tx.execute(
          sql`update ${sql.identifier(table)} set ${sql.identifier(column)} = ${sql.raw(value)}`,
        ),
      ),
    ).rejects.toMatchObject(permissionDenied);
  });

  it('relations cannot be deleted; ending one sets valid_to', async () => {
    await expect(asTenant((tx) => tx.execute(sql`delete from relations`))).rejects.toMatchObject(
      permissionDenied,
    );
    const ended = await asTenant((tx) =>
      tx.execute(sql`update relations set valid_to = now() + interval '1 second'`),
    );
    expect(ended.rowCount).toBe(1);
  });
});
