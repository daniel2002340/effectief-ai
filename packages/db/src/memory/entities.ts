import {
  type AddEntityIdentifierInput,
  addEntityIdentifierInputSchema,
  type CreateEntityInput,
  createEntityInputSchema,
  type EntityIdentifier,
  entityIdentifierSchema,
} from '@effectief/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { entities, entityIdentifiers } from '../schema/index.ts';
import type { TenantTransaction } from '../with-tenant.ts';
import { single, sourceColumnsOf } from './source.ts';

// Repository functions take a TenantTransaction from withTenant(), so callers
// can combine several steps in one transaction. tenant_id is never passed: the
// column defaults to the tenant of the transaction.

export type Entity = typeof entities.$inferSelect;
export type EntityIdentifierRow = typeof entityIdentifiers.$inferSelect;

const idSchema = z.uuid();

export async function createEntity(tx: TenantTransaction, input: CreateEntityInput) {
  const values = createEntityInputSchema.parse(input);
  return single(await tx.insert(entities).values(values).returning());
}

export async function getEntity(tx: TenantTransaction, entityId: string) {
  const [row] = await tx
    .select()
    .from(entities)
    .where(eq(entities.id, idSchema.parse(entityId)));
  return row;
}

/**
 * Adds an identifier to an entity. A value is unique per tenant: when it
 * already exists (possibly on another entity), the existing row is returned
 * with `created: false`, so the caller can decide what to do.
 */
export async function addEntityIdentifier(tx: TenantTransaction, input: AddEntityIdentifierInput) {
  const { entityId, identifier, source } = addEntityIdentifierInputSchema.parse(input);
  const [created] = await tx
    .insert(entityIdentifiers)
    .values({ entityId, ...identifier, ...sourceColumnsOf(source) })
    .onConflictDoNothing({
      target: [entityIdentifiers.tenantId, entityIdentifiers.kind, entityIdentifiers.value],
    })
    .returning();
  if (created) return { identifier: created, created: true };

  const [existing] = await tx
    .select()
    .from(entityIdentifiers)
    .where(
      and(
        eq(entityIdentifiers.kind, identifier.kind),
        eq(entityIdentifiers.value, identifier.value),
      ),
    );
  if (!existing) throw new Error('Identifier conflicted but is not visible');
  return { identifier: existing, created: false };
}

/** Exact match on a normalised identifier (e-mail lowercased, phone as E.164). */
export async function findEntityByIdentifier(tx: TenantTransaction, input: EntityIdentifier) {
  const identifier = entityIdentifierSchema.parse(input);
  const [row] = await tx
    .select({ entity: entities })
    .from(entityIdentifiers)
    .innerJoin(entities, eq(entities.id, entityIdentifiers.entityId))
    .where(
      and(
        eq(entityIdentifiers.kind, identifier.kind),
        eq(entityIdentifiers.value, identifier.value),
      ),
    );
  return row?.entity;
}

export function listEntityIdentifiers(tx: TenantTransaction, entityId: string) {
  return tx
    .select()
    .from(entityIdentifiers)
    .where(eq(entityIdentifiers.entityId, idSchema.parse(entityId)));
}
