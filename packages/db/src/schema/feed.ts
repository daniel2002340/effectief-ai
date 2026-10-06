import {
  type ActionInput,
  type ActionResult,
  type AuditMetadata,
  actionErrorCodes,
  actionStatuses,
  actionTypes,
  actorTypes,
  auditActions,
  auditObjectTypes,
  type CardPayload,
  cardKinds,
  cardStatuses,
  connectAttemptFailureCodes,
  connectionProviders,
  connectionStatuses,
  connectionStatusReasons,
  type StoredNangoWebhook,
  syncModels,
  webhookDeliveryStatuses,
  webhookErrorCodes,
  webhookSources,
} from '@effectief/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  jsonb,
  type PgTableExtraConfigValue,
  pgPolicy,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, inList, jsonbIs, memberRef, tenantId, updatedAt } from './columns.ts';
import { playbooks } from './knowledge.ts';
import { entities, events, tasks } from './memory.ts';
import { appRuntime, currentTenantId } from './roles.ts';
import { tenantIsolation } from './tenant.ts';

// Feed and actions (docs/data-model.md, part A): what comes in, what the user
// sees and what the user approves. Same rules as the memory tables: tenant_id,
// tenantIsolation(), FORCE RLS and the grants of §5 in migration 0008, and
// composite foreign keys on (tenant_id, …). Status changes go through one
// transition function per table plus a trigger with the same pairs (#044).

/** A linked integration of a tenant, pointing to a Nango connection. No tokens here. */
export const connections = pgTable(
  'connections',
  {
    id: id(),
    tenantId: tenantId(),
    provider: text('provider', { enum: connectionProviders }).notNull(),
    nangoIntegrationId: text('nango_integration_id').notNull(),
    nangoConnectionId: text('nango_connection_id').notNull(),
    externalAccountId: text('external_account_id'),
    accountLabel: text('account_label'),
    status: text('status', { enum: connectionStatuses }).default('active').notNull(),
    statusReason: text('status_reason', { enum: connectionStatusReasons }),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).defaultNow().notNull(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    connectedByUserId: uuid('connected_by_user_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('connections_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('connections_nango_connection_id_unique').on(t.nangoConnectionId),
    uniqueIndex('connections_active_account_unique')
      .on(t.tenantId, t.provider, t.externalAccountId)
      .where(sql`${t.status} = 'active'`),
    memberRef('connections_connected_by_fk', t.tenantId, t.connectedByUserId),
    check('connections_provider', inList(t.provider, connectionProviders)),
    check('connections_status', inList(t.status, connectionStatuses)),
    check(
      'connections_status_reason',
      sql`${t.statusReason} is null or ${inList(t.statusReason, connectionStatusReasons)}`,
    ),
    check('connections_purged_label', sql`${t.status} <> 'purged' or ${t.accountLabel} is null`),
    index('connections_tenant_status_idx').on(t.tenantId, t.status),
    tenantIsolation(t.tenantId),
  ],
).enableRLS();

/**
 * One "connect a mailbox" flow, started by a member (docs/integrations.md
 * §2.2). Its secret nonce is the tag on the Nango connect session; the
 * creation webhook finds the tenant through resolve_connect_attempt(nonce)
 * (migration 0019), so the tenant never comes from what Nango or the browser
 * sends. Consumed once, together with creating the connection.
 */
export const connectAttempts = pgTable(
  'connect_attempts',
  {
    id: id(),
    tenantId: tenantId(),
    /** 32 random bytes, hex. Never sent to the browser or logged. */
    nonce: text('nonce').notNull(),
    provider: text('provider', { enum: connectionProviders }).notNull(),
    nangoIntegrationId: text('nango_integration_id').notNull(),
    createdByUserId: uuid('created_by_user_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    /** The connection it became. */
    connectionId: uuid('connection_id'),
    /** The Nango connection it produced, also when it failed (to remove it there). */
    nangoConnectionId: text('nango_connection_id'),
    failureCode: text('failure_code', { enum: connectAttemptFailureCodes }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('connect_attempts_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('connect_attempts_nonce_unique').on(t.nonce),
    foreignKey({
      name: 'connect_attempts_connection_fk',
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [connections.tenantId, connections.id],
    }).onDelete('cascade'),
    memberRef('connect_attempts_created_by_fk', t.tenantId, t.createdByUserId),
    check('connect_attempts_nonce', sql`${t.nonce} ~ '^[0-9a-f]{64}$'`),
    check('connect_attempts_provider', inList(t.provider, connectionProviders)),
    check('connect_attempts_failure_code', inList(t.failureCode, connectAttemptFailureCodes)),
    check(
      'connect_attempts_outcome',
      sql`(${t.consumedAt} is null) = (${t.connectionId} is null and ${t.failureCode} is null)`,
    ),
    check(
      'connect_attempts_single_outcome',
      sql`${t.connectionId} is null or ${t.failureCode} is null`,
    ),
    index('connect_attempts_tenant_open_idx').on(t.tenantId, t.consumedAt, t.createdAt),
    tenantIsolation(t.tenantId),
  ],
).enableRLS();

/**
 * A received webhook, stored before processing (#038): the job does the work,
 * with retries, and a failure stays visible. Unique per source and delivery,
 * so a repeated delivery is a no-op. The tenant comes from the connection via
 * resolve_connection() (migration 0017), or for a new connection from its
 * attempt via resolve_connect_attempt() (0019); never from the body.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: id(),
    tenantId: tenantId(),
    /** Null only for a creation webhook, whose connection does not exist yet. */
    connectionId: uuid('connection_id'),
    /** For a creation webhook: the attempt it belongs to. */
    connectAttemptId: uuid('connect_attempt_id'),
    source: text('source', { enum: webhookSources }).notNull(),
    /** The source's delivery ID, or a hash of the body when it has none (§4.4). */
    deliveryId: text('delivery_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    /** What Zod kept of the body: IDs, codes and counts (packages/shared, webhook.ts). */
    payload: jsonb('payload').$type<StoredNangoWebhook>().notNull(),
    status: text('status', { enum: webhookDeliveryStatuses }).default('received').notNull(),
    attempts: smallint('attempts').default(0).notNull(),
    lastErrorCode: text('last_error_code', { enum: webhookErrorCodes }),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    unique('webhook_deliveries_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('webhook_deliveries_delivery_unique').on(t.tenantId, t.source, t.deliveryId),
    foreignKey({
      name: 'webhook_deliveries_connection_fk',
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [connections.tenantId, connections.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'webhook_deliveries_connect_attempt_fk',
      columns: [t.tenantId, t.connectAttemptId],
      foreignColumns: [connectAttempts.tenantId, connectAttempts.id],
    }).onDelete('cascade'),
    check(
      'webhook_deliveries_target',
      sql`num_nonnulls(${t.connectionId}, ${t.connectAttemptId}) = 1`,
    ),
    check('webhook_deliveries_source', inList(t.source, webhookSources)),
    check('webhook_deliveries_status', inList(t.status, webhookDeliveryStatuses)),
    check('webhook_deliveries_last_error_code', inList(t.lastErrorCode, webhookErrorCodes)),
    check('webhook_deliveries_payload_object', jsonbIs(t.payload, 'object')),
    check('webhook_deliveries_attempts', sql`${t.attempts} >= 0`),
    check(
      'webhook_deliveries_processed',
      sql`(${t.status} = 'processed') = (${t.processedAt} is not null)`,
    ),
    index('webhook_deliveries_tenant_status_idx').on(t.tenantId, t.status, t.receivedAt),
    tenantIsolation(t.tenantId),
  ],
).enableRLS();

/**
 * How far the app has read a connection's Nango records, per model
 * (docs/integrations.md §4.2, #076). The ingest locks the row (FOR UPDATE), so
 * one ingest runs per connection at a time. Null cursor: from the start.
 */
export const syncCursors = pgTable(
  'sync_cursors',
  {
    tenantId: tenantId(),
    connectionId: uuid('connection_id').notNull(),
    model: text('model', { enum: syncModels }).notNull(),
    cursor: text('cursor'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.connectionId, t.model] }),
    foreignKey({
      name: 'sync_cursors_connection_fk',
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [connections.tenantId, connections.id],
    }).onDelete('cascade'),
    check('sync_cursors_model', inList(t.model, syncModels)),
    tenantIsolation(t.tenantId),
  ],
).enableRLS();

/** Who an entity is at a provider (principle 4); removed when the connection is purged. */
export const entityExternalRefs = pgTable(
  'entity_external_refs',
  {
    id: id(),
    tenantId: tenantId(),
    entityId: uuid('entity_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    provider: text('provider', { enum: connectionProviders }).notNull(),
    objectType: text('object_type').notNull(),
    externalId: text('external_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('entity_external_refs_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('entity_external_refs_external_unique').on(
      t.tenantId,
      t.connectionId,
      t.objectType,
      t.externalId,
    ),
    foreignKey({
      name: 'entity_external_refs_entity_fk',
      columns: [t.tenantId, t.entityId],
      foreignColumns: [entities.tenantId, entities.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'entity_external_refs_connection_fk',
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [connections.tenantId, connections.id],
    }).onDelete('cascade'),
    check('entity_external_refs_provider', inList(t.provider, connectionProviders)),
    index('entity_external_refs_tenant_entity_idx').on(t.tenantId, t.entityId),
    tenantIsolation(t.tenantId),
  ],
).enableRLS();

/** What the user sees in the feed: a summary and a question, today. */
export const cards = pgTable(
  'cards',
  {
    id: id(),
    tenantId: tenantId(),
    kind: text('kind', { enum: cardKinds }).notNull(),
    status: text('status', { enum: cardStatuses }).default('open').notNull(),
    title: text('title').notNull(),
    summary: text('summary'),
    payload: jsonb('payload').$type<CardPayload>().notNull(),
    priority: smallint('priority').default(1).notNull(),
    dedupeKey: text('dedupe_key'),
    connectionId: uuid('connection_id'),
    taskId: uuid('task_id'),
    /** For `action_failed`: the action that failed. */
    actionId: uuid('action_id'),
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedByUserId: uuid('resolved_by_user_id'),
    aiModel: text('ai_model'),
    aiTraceId: text('ai_trace_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('cards_tenant_id_id_unique').on(t.tenantId, t.id),
    uniqueIndex('cards_open_dedupe_unique')
      .on(t.tenantId, t.dedupeKey)
      .where(sql`${t.status} in ('open', 'snoozed')`),
    foreignKey({
      name: 'cards_connection_fk',
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [connections.tenantId, connections.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'cards_task_fk',
      columns: [t.tenantId, t.taskId],
      foreignColumns: [tasks.tenantId, tasks.id],
    }).onDelete('cascade'),
    // actions is declared below; the callback runs after both tables exist.
    foreignKey({
      name: 'cards_action_fk',
      columns: [t.tenantId, t.actionId],
      foreignColumns: [actions.tenantId, actions.id],
    }).onDelete('cascade'),
    memberRef('cards_resolved_by_fk', t.tenantId, t.resolvedByUserId),
    check('cards_kind', inList(t.kind, cardKinds)),
    check('cards_status', inList(t.status, cardStatuses)),
    check('cards_payload_object', jsonbIs(t.payload, 'object')),
    check('cards_priority', sql`${t.priority} between 0 and 3`),
    check(
      'cards_resolved',
      sql`(${t.status} in ('done', 'dismissed', 'expired')) = (${t.resolvedAt} is not null)`,
    ),
    check('cards_snoozed', sql`(${t.status} = 'snoozed') = (${t.snoozedUntil} is not null)`),
    check(
      'cards_connection_problem',
      sql`(${t.kind} = 'connection_problem') = (${t.connectionId} is not null)`,
    ),
    check('cards_task_due', sql`(${t.kind} = 'task_due') = (${t.taskId} is not null)`),
    check('cards_action_failed', sql`(${t.kind} = 'action_failed') = (${t.actionId} is not null)`),
    index('cards_feed_idx').on(t.tenantId, t.status, t.priority.desc(), t.createdAt.desc()),
    tenantIsolation(t.tenantId),
  ],
).enableRLS();

export const cardEvents = pgTable(
  'card_events',
  {
    tenantId: tenantId(),
    cardId: uuid('card_id').notNull(),
    eventId: uuid('event_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.cardId, t.eventId] }),
    foreignKey({
      name: 'card_events_card_fk',
      columns: [t.tenantId, t.cardId],
      foreignColumns: [cards.tenantId, cards.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'card_events_event_fk',
      columns: [t.tenantId, t.eventId],
      foreignColumns: [events.tenantId, events.id],
    }).onDelete('cascade'),
    index('card_events_tenant_event_idx').on(t.tenantId, t.eventId),
    tenantIsolation(t.tenantId),
  ],
).enableRLS();

export const cardEntities = pgTable(
  'card_entities',
  {
    tenantId: tenantId(),
    cardId: uuid('card_id').notNull(),
    entityId: uuid('entity_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.cardId, t.entityId] }),
    foreignKey({
      name: 'card_entities_card_fk',
      columns: [t.tenantId, t.cardId],
      foreignColumns: [cards.tenantId, cards.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'card_entities_entity_fk',
      columns: [t.tenantId, t.entityId],
      foreignColumns: [entities.tenantId, entities.id],
    }).onDelete('cascade'),
    index('card_entities_tenant_entity_idx').on(t.tenantId, t.entityId),
    tenantIsolation(t.tenantId),
  ],
).enableRLS();

/**
 * A proposed write action on a card: proposeAction → approve → execute (#004).
 * The trigger actions_guard (migration 0008) enforces the transitions and that
 * input only changes in concept, proposed_input never and provider_object_id
 * never once set; actions_final_guard (0012) that a final type is not edited
 * after executing.
 */
export const actions = pgTable(
  'actions',
  {
    id: id(),
    tenantId: tenantId(),
    cardId: uuid('card_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    type: text('type', { enum: actionTypes }).notNull(),
    status: text('status', { enum: actionStatuses }).default('concept').notNull(),
    proposedInput: jsonb('proposed_input').$type<ActionInput>(),
    input: jsonb('input').$type<ActionInput>(),
    inputPurgedAt: timestamp('input_purged_at', { withTimezone: true }),
    idempotencyKey: text('idempotency_key').notNull(),
    providerObjectId: text('provider_object_id'),
    result: jsonb('result').$type<ActionResult>(),
    /** The playbook the proposal followed. */
    playbookId: uuid('playbook_id'),
    approvedByUserId: uuid('approved_by_user_id'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    /** Number of times an execute job claimed the action. */
    attempts: smallint('attempts').default(0).notNull(),
    /** The job that claimed the action (`executing`); only it may finish it. */
    executionJobId: text('execution_job_id'),
    lastErrorCode: text('last_error_code', { enum: actionErrorCodes }),
    aiModel: text('ai_model'),
    aiTraceId: text('ai_trace_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('actions_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('actions_tenant_idempotency_key_unique').on(t.tenantId, t.idempotencyKey),
    foreignKey({
      name: 'actions_card_fk',
      columns: [t.tenantId, t.cardId],
      foreignColumns: [cards.tenantId, cards.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'actions_connection_fk',
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [connections.tenantId, connections.id],
    }),
    foreignKey({
      name: 'actions_playbook_fk',
      columns: [t.tenantId, t.playbookId],
      foreignColumns: [playbooks.tenantId, playbooks.id],
    }).onDelete('set null'),
    memberRef('actions_approved_by_fk', t.tenantId, t.approvedByUserId),
    check('actions_type', inList(t.type, actionTypes)),
    check('actions_status', inList(t.status, actionStatuses)),
    check(
      'actions_executed_has_provider_object',
      sql`${t.status} <> 'executed' or ${t.providerObjectId} is not null`,
    ),
    // On approved_at, not approved_by_user_id: that one becomes NULL when the
    // member is removed, and the check would then block removing the member.
    check(
      'actions_approved',
      sql`${t.status} in ('concept', 'rejected') or ${t.approvedAt} is not null`,
    ),
    check(
      'actions_inputs_present',
      sql`(${t.inputPurgedAt} is null) = (${t.proposedInput} is not null and ${t.input} is not null)`,
    ),
    check(
      'actions_inputs_object',
      sql`(${t.proposedInput} is null or ${jsonbIs(t.proposedInput, 'object')}) and (${t.input} is null or ${jsonbIs(t.input, 'object')})`,
    ),
    check('actions_result_object', sql`${t.result} is null or ${jsonbIs(t.result, 'object')}`),
    check('actions_attempts', sql`${t.attempts} >= 0`),
    check('actions_last_error_code', inList(t.lastErrorCode, actionErrorCodes)),
    check(
      'actions_executing_has_job',
      sql`${t.status} <> 'executing' or ${t.executionJobId} is not null`,
    ),
    index('actions_tenant_card_idx').on(t.tenantId, t.cardId),
    index('actions_tenant_status_idx').on(t.tenantId, t.status),
    index('actions_tenant_playbook_idx').on(t.tenantId, t.playbookId),
    tenantIsolation(t.tenantId),
  ],
).enableRLS();

/**
 * Append-only log of everything that happened and by whom. No personal data
 * and no foreign keys besides the tenant, so it survives every deletion.
 * Only SELECT and INSERT policies; a trigger rejects UPDATE and DELETE, also
 * for the owner (migration 0008).
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    tenantId: tenantId(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
    actorType: text('actor_type', { enum: actorTypes }).notNull(),
    /** No foreign key: must remain when the user is gone. */
    actorUserId: uuid('actor_user_id'),
    action: text('action', { enum: auditActions }).notNull(),
    objectType: text('object_type', { enum: auditObjectTypes }).notNull(),
    /** No foreign key. */
    objectId: uuid('object_id'),
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    metadata: jsonb('metadata').$type<AuditMetadata>().notNull(),
    requestId: text('request_id'),
    jobId: text('job_id'),
  },
  (t) => [
    check('audit_log_actor_type', inList(t.actorType, actorTypes)),
    check('audit_log_actor_user', sql`(${t.actorType} = 'user') = (${t.actorUserId} is not null)`),
    check('audit_log_action', inList(t.action, auditActions)),
    check('audit_log_object_type', inList(t.objectType, auditObjectTypes)),
    check('audit_log_metadata_object', jsonbIs(t.metadata, 'object')),
    index('audit_log_tenant_occurred_idx').on(t.tenantId, t.occurredAt.desc()),
    index('audit_log_tenant_object_idx').on(t.tenantId, t.objectType, t.objectId),
    pgPolicy('tenant_isolation_select', {
      for: 'select',
      to: appRuntime,
      using: sql`${t.tenantId} = ${currentTenantId}`,
    }),
    pgPolicy('tenant_isolation_insert', {
      for: 'insert',
      to: appRuntime,
      withCheck: sql`${t.tenantId} = ${currentTenantId}`,
    }),
  ],
).enableRLS();
