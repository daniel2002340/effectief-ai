import {
  type CompanyDetails,
  companySectors,
  documentOrigins,
  documentStatuses,
  type FactStructured,
  type InsightPayload,
  insightKinds,
  insightPerEntity,
  knowledgeStatuses,
  type OpeningHours,
  playbookScopes,
  playbookStatuses,
} from '@effectief/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  check,
  type ForeignKeyBuilder,
  foreignKey,
  index,
  integer,
  jsonb,
  type PgTableExtraConfigValue,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { member } from './auth.ts';
import {
  createdAt,
  embeddingModelCheck,
  id,
  inList,
  jsonbIs,
  memberRef,
  sourceColumns,
  sourceTypeCheck,
  tenantId,
  updatedAt,
  vector,
} from './columns.ts';
import { actions, connections } from './feed.ts';
import { actionRef, entities, eventRef, events } from './memory.ts';
import { tenantIsolation } from './tenant.ts';

// Knowledge (docs/data-model.md, part B and C): facts, playbooks, documents,
// the company profile and insights, plus their embeddings. Same rules as the
// other tenant tables: tenant_id, tenantIsolation(), FORCE RLS and the grants
// of §5 in migration 0010, composite foreign keys on (tenant_id, …), and
// `ON DELETE SET NULL (column)` rewritten by hand in the migration.

export const chunkRef = (
  name: string,
  tenant: AnyPgColumn,
  chunk: AnyPgColumn,
): ForeignKeyBuilder =>
  foreignKey({
    name,
    columns: [tenant, chunk],
    foreignColumns: [documentChunks.tenantId, documentChunks.id],
  }).onDelete('set null');

/** The source foreign keys of §3.6 for a knowledge table. */
const sourceRefs = (
  table: string,
  t: {
    tenantId: AnyPgColumn;
    sourceEventId: AnyPgColumn;
    sourceChunkId: AnyPgColumn;
    sourceUserId: AnyPgColumn;
    sourceActionId: AnyPgColumn;
  },
) => [
  eventRef(`${table}_source_event_fk`, t.tenantId, t.sourceEventId),
  chunkRef(`${table}_source_chunk_fk`, t.tenantId, t.sourceChunkId),
  memberRef(`${table}_source_user_fk`, t.tenantId, t.sourceUserId),
  actionRef(`${table}_source_action_fk`, t.tenantId, t.sourceActionId),
];

/**
 * The columns of an embedding row (docs/data-model.md §3.5): the space
 * (`model` + `dimensions`, keys of packages/ai/models.ts) and the provider
 * model that produced the vector (`model_version`).
 */
const embeddingColumns = () => ({
  tenantId: tenantId(),
  model: text('model').notNull(),
  modelVersion: text('model_version').notNull(),
  dimensions: smallint('dimensions').notNull(),
  embedding: vector('embedding').notNull(),
  createdAt: createdAt(),
});

/**
 * Durable truths about an entity. Content is immutable (§5): correcting a
 * fact creates a new one and ends the old one with valid_to and superseded_by_id.
 */
export const facts = pgTable(
  'facts',
  {
    id: id(),
    tenantId: tenantId(),
    entityId: uuid('entity_id').notNull(),
    statement: text('statement').notNull(),
    attribute: text('attribute'),
    structured: jsonb('structured').$type<FactStructured>(),
    status: text('status', { enum: knowledgeStatuses }).default('proposed').notNull(),
    confidence: real('confidence'),
    validFrom: timestamp('valid_from', { withTimezone: true }).defaultNow().notNull(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    supersededById: uuid('superseded_by_id'),
    confirmedByUserId: uuid('confirmed_by_user_id'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    lastConfirmedAt: timestamp('last_confirmed_at', { withTimezone: true }),
    ...sourceColumns(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('facts_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({
      name: 'facts_entity_fk',
      columns: [t.tenantId, t.entityId],
      foreignColumns: [entities.tenantId, entities.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'facts_superseded_by_fk',
      columns: [t.tenantId, t.supersededById],
      foreignColumns: [t.tenantId, t.id],
    }).onDelete('set null'),
    memberRef('facts_confirmed_by_fk', t.tenantId, t.confirmedByUserId),
    ...sourceRefs('facts', t),
    check('facts_status', inList(t.status, knowledgeStatuses)),
    sourceTypeCheck('facts', t.sourceType),
    check('facts_confidence', sql`${t.confidence} between 0 and 1`),
    check('facts_valid_period', sql`${t.validTo} is null or ${t.validTo} > ${t.validFrom}`),
    // On confirmed_at, not confirmed_by_user_id: that one becomes NULL when the
    // member is removed, and the check would then block removing the member.
    check('facts_confirmed_at', sql`${t.status} <> 'confirmed' or ${t.confirmedAt} is not null`),
    check('facts_superseded_ended', sql`${t.supersededById} is null or ${t.validTo} is not null`),
    check('facts_not_superseded_by_self', sql`${t.supersededById} <> ${t.id}`),
    check(
      'facts_structured',
      sql`${t.structured} is null or (${jsonbIs(t.structured, 'object')} and ${t.structured}->>'attribute' = ${t.attribute})`,
    ),
    uniqueIndex('facts_current_unique')
      .on(t.tenantId, t.entityId, t.attribute)
      .where(
        sql`${t.status} = 'confirmed' and ${t.validTo} is null and ${t.attribute} is not null`,
      ),
    index('facts_tenant_entity_status_idx')
      .on(t.tenantId, t.entityId, t.status)
      .where(sql`${t.validTo} is null`),
    index('facts_tenant_status_created_idx').on(t.tenantId, t.status, t.createdAt),
    tenantIsolation(t.tenantId),
  ],
).enableRLS();

export const factEmbeddings = pgTable(
  'fact_embeddings',
  { factId: uuid('fact_id').notNull(), ...embeddingColumns() },
  (t) => [
    primaryKey({ columns: [t.factId, t.model] }),
    foreignKey({
      name: 'fact_embeddings_fact_fk',
      columns: [t.tenantId, t.factId],
      foreignColumns: [facts.tenantId, facts.id],
    }).onDelete('cascade'),
    ...embeddingModelCheck('fact_embeddings', t),
    index('fact_embeddings_tenant_model_idx').on(t.tenantId, t.model),
    tenantIsolation(t.tenantId),
  ],
).enableRLS();

/**
 * How the company handles something. Content is immutable: a change is a new
 * version (`supersedes_id`, version + 1) that retires the old one once confirmed.
 */
export const playbooks = pgTable(
  'playbooks',
  {
    id: id(),
    tenantId: tenantId(),
    title: text('title').notNull(),
    triggerDescription: text('trigger_description').notNull(),
    instruction: text('instruction').notNull(),
    template: text('template'),
    scope: text('scope', { enum: playbookScopes }).notNull(),
    scopeUserId: uuid('scope_user_id'),
    scopeEntityId: uuid('scope_entity_id'),
    status: text('status', { enum: playbookStatuses }).default('proposed').notNull(),
    version: smallint('version').default(1).notNull(),
    supersedesId: uuid('supersedes_id'),
    confirmedByUserId: uuid('confirmed_by_user_id'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    ...sourceColumns(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('playbooks_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({
      name: 'playbooks_scope_user_fk',
      columns: [t.tenantId, t.scopeUserId],
      foreignColumns: [member.organizationId, member.userId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'playbooks_scope_entity_fk',
      columns: [t.tenantId, t.scopeEntityId],
      foreignColumns: [entities.tenantId, entities.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'playbooks_supersedes_fk',
      columns: [t.tenantId, t.supersedesId],
      foreignColumns: [t.tenantId, t.id],
    }).onDelete('set null'),
    memberRef('playbooks_confirmed_by_fk', t.tenantId, t.confirmedByUserId),
    ...sourceRefs('playbooks', t),
    check('playbooks_scope', inList(t.scope, playbookScopes)),
    check('playbooks_status', inList(t.status, playbookStatuses)),
    sourceTypeCheck('playbooks', t.sourceType),
    check('playbooks_scope_user', sql`(${t.scope} = 'user') = (${t.scopeUserId} is not null)`),
    check(
      'playbooks_scope_customer',
      sql`(${t.scope} = 'customer') = (${t.scopeEntityId} is not null)`,
    ),
    // Retired is only reached from confirmed. On confirmed_at for the same
    // reason as facts_confirmed_at.
    check(
      'playbooks_confirmed_at',
      sql`${t.status} not in ('confirmed', 'retired') or ${t.confirmedAt} is not null`,
    ),
    check('playbooks_version', sql`${t.version} >= 1`),
    check('playbooks_not_superseding_self', sql`${t.supersedesId} <> ${t.id}`),
    index('playbooks_tenant_status_scope_idx').on(t.tenantId, t.status, t.scope),
    index('playbooks_tenant_scope_entity_idx').on(t.tenantId, t.scopeEntityId),
    index('playbooks_tenant_supersedes_idx').on(t.tenantId, t.supersedesId),
    tenantIsolation(t.tenantId),
  ],
).enableRLS();

/** Few-shot examples; cascaded from their source, so forget removes them too. */
export const playbookExamples = pgTable(
  'playbook_examples',
  {
    id: id(),
    tenantId: tenantId(),
    playbookId: uuid('playbook_id').notNull(),
    sourceEventId: uuid('source_event_id'),
    sourceActionId: uuid('source_action_id'),
    inputExcerpt: text('input_excerpt').notNull(),
    outputText: text('output_text').notNull(),
    createdAt: createdAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('playbook_examples_tenant_id_id_unique').on(t.tenantId, t.id),
    foreignKey({
      name: 'playbook_examples_playbook_fk',
      columns: [t.tenantId, t.playbookId],
      foreignColumns: [playbooks.tenantId, playbooks.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'playbook_examples_source_event_fk',
      columns: [t.tenantId, t.sourceEventId],
      foreignColumns: [events.tenantId, events.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'playbook_examples_source_action_fk',
      columns: [t.tenantId, t.sourceActionId],
      foreignColumns: [actions.tenantId, actions.id],
    }).onDelete('cascade'),
    check(
      'playbook_examples_has_source',
      sql`${t.sourceEventId} is not null or ${t.sourceActionId} is not null`,
    ),
    index('playbook_examples_tenant_playbook_idx').on(t.tenantId, t.playbookId),
    tenantIsolation(t.tenantId),
  ],
).enableRLS();

export const playbookEmbeddings = pgTable(
  'playbook_embeddings',
  { playbookId: uuid('playbook_id').notNull(), ...embeddingColumns() },
  (t) => [
    primaryKey({ columns: [t.playbookId, t.model] }),
    foreignKey({
      name: 'playbook_embeddings_playbook_fk',
      columns: [t.tenantId, t.playbookId],
      foreignColumns: [playbooks.tenantId, playbooks.id],
    }).onDelete('cascade'),
    ...embeddingModelCheck('playbook_embeddings', t),
    index('playbook_embeddings_tenant_model_idx').on(t.tenantId, t.model),
    tenantIsolation(t.tenantId),
  ],
).enableRLS();

/** An uploaded or synced document; the original lives in object storage. */
export const documents = pgTable(
  'documents',
  {
    id: id(),
    tenantId: tenantId(),
    title: text('title').notNull(),
    origin: text('origin', { enum: documentOrigins }).notNull(),
    connectionId: uuid('connection_id'),
    externalId: text('external_id'),
    storageKey: text('storage_key'),
    mimeType: text('mime_type').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    status: text('status', { enum: documentStatuses }).default('pending').notNull(),
    uploadedByUserId: uuid('uploaded_by_user_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('documents_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('documents_tenant_sha256_unique').on(t.tenantId, t.sha256),
    foreignKey({
      name: 'documents_connection_fk',
      columns: [t.tenantId, t.connectionId],
      foreignColumns: [connections.tenantId, connections.id],
    }).onDelete('cascade'),
    memberRef('documents_uploaded_by_fk', t.tenantId, t.uploadedByUserId),
    check('documents_origin', inList(t.origin, documentOrigins)),
    check('documents_status', inList(t.status, documentStatuses)),
    check(
      'documents_connection',
      sql`(${t.origin} = 'connection') = (${t.connectionId} is not null and ${t.externalId} is not null)`,
    ),
    check('documents_byte_size', sql`${t.byteSize} >= 0`),
    check('documents_sha256', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    index('documents_tenant_status_idx').on(t.tenantId, t.status),
    tenantIsolation(t.tenantId),
  ],
).enableRLS();

export const documentChunks = pgTable(
  'document_chunks',
  {
    id: id(),
    tenantId: tenantId(),
    documentId: uuid('document_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    headingPath: text('heading_path'),
    content: text('content').notNull(),
    tokenCount: integer('token_count').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('document_chunks_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('document_chunks_document_ordinal_unique').on(t.documentId, t.ordinal),
    foreignKey({
      name: 'document_chunks_document_fk',
      columns: [t.tenantId, t.documentId],
      foreignColumns: [documents.tenantId, documents.id],
    }).onDelete('cascade'),
    check('document_chunks_ordinal', sql`${t.ordinal} >= 0`),
    check('document_chunks_token_count', sql`${t.tokenCount} >= 0`),
    tenantIsolation(t.tenantId),
  ],
).enableRLS();

export const chunkEmbeddings = pgTable(
  'chunk_embeddings',
  { chunkId: uuid('chunk_id').notNull(), ...embeddingColumns() },
  (t) => [
    primaryKey({ columns: [t.chunkId, t.model] }),
    foreignKey({
      name: 'chunk_embeddings_chunk_fk',
      columns: [t.tenantId, t.chunkId],
      foreignColumns: [documentChunks.tenantId, documentChunks.id],
    }).onDelete('cascade'),
    ...embeddingModelCheck('chunk_embeddings', t),
    index('chunk_embeddings_tenant_model_idx').on(t.tenantId, t.model),
    tenantIsolation(t.tenantId),
  ],
).enableRLS();

/** Documents in which an entity occurs. */
export const documentEntities = pgTable(
  'document_entities',
  {
    tenantId: tenantId(),
    documentId: uuid('document_id').notNull(),
    entityId: uuid('entity_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.documentId, t.entityId] }),
    foreignKey({
      name: 'document_entities_document_fk',
      columns: [t.tenantId, t.documentId],
      foreignColumns: [documents.tenantId, documents.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'document_entities_entity_fk',
      columns: [t.tenantId, t.entityId],
      foreignColumns: [entities.tenantId, entities.id],
    }).onDelete('cascade'),
    index('document_entities_tenant_entity_idx').on(t.tenantId, t.entityId),
    tenantIsolation(t.tenantId),
  ],
).enableRLS();

/** Who the company itself is; one row per tenant, managed by the user. */
export const companyProfile = pgTable(
  'company_profile',
  {
    tenantId: tenantId().primaryKey(),
    tradeName: text('trade_name').notNull(),
    kvkNumber: text('kvk_number'),
    vatNumber: text('vat_number'),
    sector: text('sector', { enum: companySectors }).notNull(),
    servicesDescription: text('services_description'),
    serviceArea: text('service_area'),
    toneOfVoice: text('tone_of_voice'),
    /** Added below mails in code, never through the prompt. */
    emailSignature: text('email_signature'),
    openingHours: jsonb('opening_hours').$type<OpeningHours>(),
    details: jsonb('details').$type<CompanyDetails>().default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('company_profile_sector', inList(t.sector, companySectors)),
    check(
      'company_profile_opening_hours_object',
      sql`${t.openingHours} is null or ${jsonbIs(t.openingHours, 'object')}`,
    ),
    check('company_profile_details_object', jsonbIs(t.details, 'object')),
    tenantIsolation(t.tenantId),
  ],
).enableRLS();

const perEntityKinds = insightKinds.filter((kind) => insightPerEntity[kind]);

/** Derived, recomputable insights; recomputing is an upsert on (kind, entity). */
export const insights = pgTable(
  'insights',
  {
    id: id(),
    tenantId: tenantId(),
    kind: text('kind', { enum: insightKinds }).notNull(),
    entityId: uuid('entity_id'),
    payload: jsonb('payload').$type<InsightPayload>().notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('insights_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('insights_tenant_kind_entity_unique')
      .on(t.tenantId, t.kind, t.entityId)
      .nullsNotDistinct(),
    foreignKey({
      name: 'insights_entity_fk',
      columns: [t.tenantId, t.entityId],
      foreignColumns: [entities.tenantId, entities.id],
    }).onDelete('cascade'),
    check('insights_kind', inList(t.kind, insightKinds)),
    check(
      'insights_entity',
      sql`(${inList(t.kind, perEntityKinds)}) = (${t.entityId} is not null)`,
    ),
    check('insights_payload_object', jsonbIs(t.payload, 'object')),
    check('insights_expiry', sql`${t.expiresAt} > ${t.computedAt}`),
    index('insights_tenant_entity_idx').on(t.tenantId, t.entityId),
    tenantIsolation(t.tenantId),
  ],
).enableRLS();
