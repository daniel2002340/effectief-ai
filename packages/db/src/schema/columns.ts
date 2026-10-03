import { embeddingModels } from '@effectief/ai';
import { sourceTypes } from '@effectief/shared';
import { type SQL, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  customType,
  foreignKey,
  type PgColumn,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { member, organization } from './auth.ts';
import { currentTenantId } from './roles.ts';

// Shared columns and constraints for tenant tables (docs/data-model.md §3, §4).

/** UUIDv7 from the database (migration 0004), so raw SQL gets an id too (#033). */
export const id = () => uuid('id').primaryKey().default(sql`public.gen_uuid_v7()`);

/**
 * Defaults to the tenant set by withTenant(), so repository code never passes
 * a tenant id and cannot pass a wrong one. Outside withTenant() the default is
 * NULL and the insert fails.
 */
export const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .default(currentTenantId)
    .references(() => organization.id, { onDelete: 'cascade' });

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).defaultNow().notNull();

export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull();

/** `column in ('a', 'b')` for a closed list from packages/shared (decision #035). */
export const inList = (column: PgColumn, values: readonly string[]): SQL =>
  sql`${column} in (${sql.raw(values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', '))})`;

export const jsonbIs = (column: AnyPgColumn, type: 'object' | 'array'): SQL =>
  sql`jsonb_typeof(${column}) = ${sql.raw(`'${type}'`)}`;

/** (tenant_id, user_id) → member, so only members of the tenant can be referenced. */
export const memberRef = (name: string, tenant: AnyPgColumn, user: AnyPgColumn) =>
  foreignKey({
    name,
    columns: [tenant, user],
    foreignColumns: [member.organizationId, member.userId],
  }).onDelete('set null');

/** Source columns for AI knowledge (docs/data-model.md §3.6). */
export const sourceColumns = () => ({
  sourceType: text('source_type', { enum: sourceTypes }).notNull(),
  sourceEventId: uuid('source_event_id'),
  sourceChunkId: uuid('source_chunk_id'),
  sourceUserId: uuid('source_user_id'),
  sourceActionId: uuid('source_action_id'),
  aiModel: text('ai_model'),
  aiTraceId: text('ai_trace_id'),
});

export const sourceTypeCheck = (table: string, column: PgColumn) =>
  check(`${table}_source_type`, inList(column, sourceTypes));

/**
 * pgvector `vector` without a fixed dimension: the dimension is stored per row
 * and checked against the model (docs/data-model.md §3.5). HNSW indexes cast
 * to the fixed dimension of one model, in a hand-written migration.
 */
export const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector',
  toDriver: (value) => `[${value.join(',')}]`,
  fromDriver: (value) => JSON.parse(value) as number[],
});

/**
 * Every (model, model_version, dimensions) combination in packages/ai/models.ts.
 * A row with another combination, or whose vector has another dimension than
 * the row says, is rejected by the database.
 */
export const embeddingModelCheck = (
  table: string,
  t: { model: PgColumn; modelVersion: PgColumn; dimensions: PgColumn; embedding: PgColumn },
) => {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const allowed = Object.entries(embeddingModels).flatMap(([model, config]) =>
    [config.documentVersion, config.queryVersion].map(
      (version) => `(${quote(model)}, ${quote(version)}, ${config.dimensions})`,
    ),
  );
  return [
    check(
      `${table}_model`,
      sql`(${t.model}, ${t.modelVersion}, ${t.dimensions}) in (${sql.raw(allowed.join(', '))})`,
    ),
    check(`${table}_dimensions`, sql`vector_dims(${t.embedding}) = ${t.dimensions}`),
  ];
};
