import {
  type AttachmentMeta,
  type EntityAttributes,
  type EventPayload,
  entityTypes,
  eventEntityRoles,
  eventSources,
  eventTypes,
  identifierKinds,
  knowledgeStatuses,
  linkedByValues,
  relationTypes,
  taskCreatedByValues,
  taskStatuses,
} from '@effectief/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  type ForeignKeyBuilder,
  foreignKey,
  index,
  jsonb,
  type PgTableExtraConfigValue,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  createdAt,
  id,
  inList,
  jsonbIs,
  memberRef,
  sourceColumns,
  sourceTypeCheck,
  tenantId,
  updatedAt,
} from './columns.ts';
import { actions, cards, connections } from './feed.ts';
import { tenantIsolation } from './tenant.ts';

// The company memory (docs/data-model.md, part B and the timeline). Every
// table: tenant_id, tenantIsolation(), FORCE RLS and the grants of §5 in
// migration 0006. References between tenant tables are composite foreign keys
// on (tenant_id, …), so a row can never point to another tenant's row.
//
// Foreign keys declared here with onDelete('set null') are rewritten in the
// migration to `ON DELETE SET NULL (column)`, so tenant_id stays put; drizzle-kit
// cannot generate that form.

// Return types are explicit: events, actions, cards and tasks reference each
// other, which TypeScript cannot infer.
const eventRef = (name: string, tenant: AnyPgColumn, event: AnyPgColumn): ForeignKeyBuilder =>
  foreignKey({
    name,
    columns: [tenant, event],
    foreignColumns: [events.tenantId, events.id],
  }).onDelete('set null');

const actionRef = (name: string, tenant: AnyPgColumn, action: AnyPgColumn): ForeignKeyBuilder =>
  foreignKey({
    name,
    columns: [tenant, action],
    foreignColumns: [actions.tenantId, actions.id],
  }).onDelete('set null');

/** The things a company works with: contacts, companies, projects. */
export const entities = pgTable(
  'entities',
  {
    id: id(),
    tenantId: tenantId(),
    type: text('type', { enum: entityTypes }).notNull(),
    name: text('name').notNull(),
    attributes: jsonb('attributes').$type<EntityAttributes>().notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    mergedIntoId: uuid('merged_into_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('entities_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({
      name: 'entities_merged_into_fk',
      columns: [t.tenantId, t.mergedIntoId],
      foreignColumns: [t.tenantId, t.id],
    }).onDelete('set null'),
    check('entities_type', inList(t.type, entityTypes)),
    check('entities_attributes_object', jsonbIs(t.attributes, 'object')),
    check('entities_not_merged_into_self', sql`${t.mergedIntoId} <> ${t.id}`),
    index('entities_tenant_type_name_idx').on(t.tenantId, t.type, t.name),
    tenantIsolation(t.tenantId),
  ],
).enableRLS();

/**
 * The episodic timeline: one row per thing that happened. Append-only; only
 * summary and summarized_at can be set, once (trigger in migration 0006).
 */
export const events = pgTable(
  'events',
  {
    id: id(),
    tenantId: tenantId(),
    source: text('source', { enum: eventSources }).notNull(),
    externalId: text('external_id').notNull(),
    type: text('type', { enum: eventTypes }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    threadKey: text('thread_key'),
    summary: text('summary'),
    summarizedAt: timestamp('summarized_at', { withTimezone: true }),
    payload: jsonb('payload').$type<EventPayload>().notNull(),
    /** Null for events from the app itself. */
    connectionId: uuid('connection_id'),
    causedByActionId: uuid('caused_by_action_id'),
    createdAt: createdAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('events_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({
      name: 'events_connection_fk',
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [connections.tenantId, connections.id],
    }).onDelete('set null'),
    actionRef('events_caused_by_action_fk', t.tenantId, t.causedByActionId),
    unique('events_tenant_source_external_id_unique').on(t.tenantId, t.source, t.externalId),
    check('events_source', inList(t.source, eventSources)),
    check('events_type', inList(t.type, eventTypes)),
    check('events_payload_object', jsonbIs(t.payload, 'object')),
    check('events_summarized', sql`(${t.summary} is null) = (${t.summarizedAt} is null)`),
    index('events_tenant_occurred_idx').on(t.tenantId, t.occurredAt.desc()),
    index('events_tenant_thread_idx').on(t.tenantId, t.threadKey),
    index('events_tenant_type_occurred_idx').on(t.tenantId, t.type, t.occurredAt.desc()),
    tenantIsolation(t.tenantId),
  ],
).enableRLS();

/** What an entity is recognised by; basis for linking mail to contacts. */
export const entityIdentifiers = pgTable(
  'entity_identifiers',
  {
    id: id(),
    tenantId: tenantId(),
    entityId: uuid('entity_id').notNull(),
    kind: text('kind', { enum: identifierKinds }).notNull(),
    /** Normalised: lowercase e-mail, E.164 phone. */
    value: text('value').notNull(),
    ...sourceColumns(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('entity_identifiers_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('entity_identifiers_tenant_kind_value_unique').on(t.tenantId, t.kind, t.value),
    foreignKey({
      name: 'entity_identifiers_entity_fk',
      columns: [t.tenantId, t.entityId],
      foreignColumns: [entities.tenantId, entities.id],
    }).onDelete('cascade'),
    eventRef('entity_identifiers_source_event_fk', t.tenantId, t.sourceEventId),
    memberRef('entity_identifiers_source_user_fk', t.tenantId, t.sourceUserId),
    actionRef('entity_identifiers_source_action_fk', t.tenantId, t.sourceActionId),
    check('entity_identifiers_kind', inList(t.kind, identifierKinds)),
    sourceTypeCheck('entity_identifiers', t.sourceType),
    index('entity_identifiers_tenant_entity_idx').on(t.tenantId, t.entityId),
    tenantIsolation(t.tenantId),
  ],
).enableRLS();

/** Links between entities, valid over time. Content is immutable (§5). */
export const entityRelations = pgTable(
  'relations',
  {
    id: id(),
    tenantId: tenantId(),
    fromEntityId: uuid('from_entity_id').notNull(),
    toEntityId: uuid('to_entity_id').notNull(),
    type: text('type', { enum: relationTypes }).notNull(),
    status: text('status', { enum: knowledgeStatuses }).notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }).defaultNow().notNull(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    confirmedByUserId: uuid('confirmed_by_user_id'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    ...sourceColumns(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('relations_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({
      name: 'relations_from_entity_fk',
      columns: [t.tenantId, t.fromEntityId],
      foreignColumns: [entities.tenantId, entities.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'relations_to_entity_fk',
      columns: [t.tenantId, t.toEntityId],
      foreignColumns: [entities.tenantId, entities.id],
    }).onDelete('cascade'),
    memberRef('relations_confirmed_by_fk', t.tenantId, t.confirmedByUserId),
    eventRef('relations_source_event_fk', t.tenantId, t.sourceEventId),
    memberRef('relations_source_user_fk', t.tenantId, t.sourceUserId),
    actionRef('relations_source_action_fk', t.tenantId, t.sourceActionId),
    check('relations_type', inList(t.type, relationTypes)),
    check('relations_status', inList(t.status, knowledgeStatuses)),
    sourceTypeCheck('relations', t.sourceType),
    check('relations_distinct_entities', sql`${t.fromEntityId} <> ${t.toEntityId}`),
    check('relations_valid_period', sql`${t.validTo} is null or ${t.validTo} > ${t.validFrom}`),
    check(
      'relations_confirmed_at',
      sql`${t.status} <> 'confirmed' or ${t.confirmedAt} is not null`,
    ),
    uniqueIndex('relations_current_unique')
      .on(t.tenantId, t.fromEntityId, t.toEntityId, t.type)
      .where(sql`${t.validTo} is null and ${t.status} <> 'rejected'`),
    index('relations_tenant_to_entity_idx').on(t.tenantId, t.toEntityId),
    tenantIsolation(t.tenantId),
  ],
).enableRLS();

/** Full source content of an event, deleted after `retain_until` (#037). Immutable. */
export const eventContents = pgTable(
  'event_contents',
  {
    eventId: uuid('event_id').primaryKey(),
    tenantId: tenantId(),
    fromAddress: text('from_address'),
    toAddresses: text('to_addresses').array(),
    subject: text('subject'),
    bodyText: text('body_text'),
    attachments: jsonb('attachments').$type<AttachmentMeta[]>(),
    retainUntil: timestamp('retain_until', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'event_contents_event_fk',
      columns: [t.tenantId, t.eventId],
      foreignColumns: [events.tenantId, events.id],
    }).onDelete('cascade'),
    check(
      'event_contents_attachments_array',
      sql`${t.attachments} is null or ${jsonbIs(t.attachments, 'array')}`,
    ),
    index('event_contents_tenant_retain_until_idx').on(t.tenantId, t.retainUntil),
    tenantIsolation(t.tenantId),
  ],
).enableRLS();

/** Which entities an event is about, and in which role. */
export const eventEntities = pgTable(
  'event_entities',
  {
    tenantId: tenantId(),
    eventId: uuid('event_id').notNull(),
    entityId: uuid('entity_id').notNull(),
    role: text('role', { enum: eventEntityRoles }).notNull(),
    linkedBy: text('linked_by', { enum: linkedByValues }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.entityId, t.role] }),
    foreignKey({
      name: 'event_entities_event_fk',
      columns: [t.tenantId, t.eventId],
      foreignColumns: [events.tenantId, events.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'event_entities_entity_fk',
      columns: [t.tenantId, t.entityId],
      foreignColumns: [entities.tenantId, entities.id],
    }).onDelete('cascade'),
    check('event_entities_role', inList(t.role, eventEntityRoles)),
    check('event_entities_linked_by', inList(t.linkedBy, linkedByValues)),
    index('event_entities_tenant_entity_event_idx').on(t.tenantId, t.entityId, t.eventId),
    tenantIsolation(t.tenantId),
  ],
).enableRLS();

/** Something the user still has to do. */
export const tasks = pgTable(
  'tasks',
  {
    id: id(),
    tenantId: tenantId(),
    title: text('title').notNull(),
    notes: text('notes'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    status: text('status', { enum: taskStatuses }).default('open').notNull(),
    assigneeUserId: uuid('assignee_user_id'),
    createdBy: text('created_by', { enum: taskCreatedByValues }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedByUserId: uuid('completed_by_user_id'),
    /** The card it came from, when the user accepted a suggestion. */
    originCardId: uuid('origin_card_id'),
    ...sourceColumns(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('tasks_tenant_id_id_unique').on(t.tenantId, t.id),
    memberRef('tasks_assignee_fk', t.tenantId, t.assigneeUserId),
    memberRef('tasks_completed_by_fk', t.tenantId, t.completedByUserId),
    foreignKey({
      name: 'tasks_origin_card_fk',
      columns: [t.tenantId, t.originCardId],
      foreignColumns: [cards.tenantId, cards.id],
    }).onDelete('set null'),
    eventRef('tasks_source_event_fk', t.tenantId, t.sourceEventId),
    memberRef('tasks_source_user_fk', t.tenantId, t.sourceUserId),
    actionRef('tasks_source_action_fk', t.tenantId, t.sourceActionId),
    check('tasks_status', inList(t.status, taskStatuses)),
    check('tasks_created_by', inList(t.createdBy, taskCreatedByValues)),
    sourceTypeCheck('tasks', t.sourceType),
    check('tasks_completed', sql`(${t.status} = 'done') = (${t.completedAt} is not null)`),
    index('tasks_tenant_status_due_idx').on(t.tenantId, t.status, t.dueAt),
    index('tasks_tenant_assignee_status_idx').on(t.tenantId, t.assigneeUserId, t.status),
    tenantIsolation(t.tenantId),
  ],
).enableRLS();

export const taskEntities = pgTable(
  'task_entities',
  {
    tenantId: tenantId(),
    taskId: uuid('task_id').notNull(),
    entityId: uuid('entity_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.entityId] }),
    foreignKey({
      name: 'task_entities_task_fk',
      columns: [t.tenantId, t.taskId],
      foreignColumns: [tasks.tenantId, tasks.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'task_entities_entity_fk',
      columns: [t.tenantId, t.entityId],
      foreignColumns: [entities.tenantId, entities.id],
    }).onDelete('cascade'),
    index('task_entities_tenant_entity_idx').on(t.tenantId, t.entityId),
    tenantIsolation(t.tenantId),
  ],
).enableRLS();
