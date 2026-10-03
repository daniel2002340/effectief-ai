import { type CreateRelationInput, createRelationInputSchema } from '@effectief/shared';
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { z } from 'zod';
import { entityRelations } from '../schema/index.ts';
import type { TenantTransaction } from '../with-tenant.ts';
import { single, sourceColumnsOf } from './source.ts';

export type Relation = typeof entityRelations.$inferSelect;

/** Always `proposed`: confirming is a separate user step (docs/data-model.md §2). */
export async function createRelation(tx: TenantTransaction, input: CreateRelationInput) {
  const { source, ...relation } = createRelationInputSchema.parse(input);
  return single(
    await tx
      .insert(entityRelations)
      .values({ ...relation, status: 'proposed', ...sourceColumnsOf(source) })
      .returning(),
  );
}

/** Current relations of an entity in either direction: not ended, not rejected. */
export function listRelations(tx: TenantTransaction, entityId: string) {
  const id = z.uuid().parse(entityId);
  return tx
    .select()
    .from(entityRelations)
    .where(
      and(
        or(eq(entityRelations.fromEntityId, id), eq(entityRelations.toEntityId, id)),
        isNull(entityRelations.validTo),
        ne(entityRelations.status, 'rejected'),
      ),
    )
    .orderBy(entityRelations.createdAt);
}
