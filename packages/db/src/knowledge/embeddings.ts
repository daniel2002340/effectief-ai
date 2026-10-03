import { type EmbeddingModel, embeddingModels } from '@effectief/ai';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { chunkEmbeddings, factEmbeddings, playbookEmbeddings } from '../schema/index.ts';
import { currentTenantId } from '../schema/roles.ts';
import type { TenantTransaction } from '../with-tenant.ts';

// Embeddings per kind of owner (docs/data-model.md §3.5). Each row stores the
// space (`model`, `dimensions`) and the provider model that produced it
// (`model_version`), so a model switch can run side by side. A vector whose
// length does not match the model is refused here, and by two database checks.

const targets = {
  fact: { table: factEmbeddings, owner: factEmbeddings.factId, name: 'fact_embeddings' },
  playbook: {
    table: playbookEmbeddings,
    owner: playbookEmbeddings.playbookId,
    name: 'playbook_embeddings',
  },
  chunk: { table: chunkEmbeddings, owner: chunkEmbeddings.chunkId, name: 'chunk_embeddings' },
} as const;

export type EmbeddingKind = keyof typeof targets;

const modelSchema = z.enum(Object.keys(embeddingModels) as [EmbeddingModel, ...EmbeddingModel[]]);
const vectorSchema = z.array(z.number().finite()).min(1);

const dimensionsMessage = (model: EmbeddingModel, length: number) =>
  `Embedding heeft ${length} dimensies; ${model} vraagt ${embeddingModels[model].dimensions}`;

export const storeEmbeddingInputSchema = z
  .strictObject({
    ownerId: z.uuid(),
    model: modelSchema,
    /** The provider model that produced the vector; one of the versions of the space. */
    modelVersion: z.string().min(1),
    embedding: vectorSchema,
  })
  .superRefine((input, ctx) => {
    const config = embeddingModels[input.model];
    if (input.embedding.length !== config.dimensions) {
      ctx.addIssue({
        code: 'custom',
        path: ['embedding'],
        message: dimensionsMessage(input.model, input.embedding.length),
      });
    }
    const versions: string[] = [config.documentVersion, config.queryVersion];
    if (!versions.includes(input.modelVersion)) {
      ctx.addIssue({
        code: 'custom',
        path: ['modelVersion'],
        message: `Onbekende versie voor ${input.model}`,
      });
    }
  });
export type StoreEmbeddingInput = z.input<typeof storeEmbeddingInputSchema>;

export const searchEmbeddingsInputSchema = z
  .strictObject({
    model: modelSchema,
    embedding: vectorSchema,
    limit: z.int().min(1).max(100).default(10),
  })
  .superRefine((input, ctx) => {
    if (input.embedding.length !== embeddingModels[input.model].dimensions) {
      ctx.addIssue({
        code: 'custom',
        path: ['embedding'],
        message: dimensionsMessage(input.model, input.embedding.length),
      });
    }
  });
export type SearchEmbeddingsInput = z.input<typeof searchEmbeddingsInputSchema>;

const kindSchema = z.enum(Object.keys(targets) as [EmbeddingKind, ...EmbeddingKind[]]);
const toVector = (values: number[]) => `[${values.join(',')}]`;

/**
 * Stores the embedding of an owner in one space. Owners are immutable, so an
 * existing row for (owner, model) is kept: `created: false` (idempotent backfill).
 */
export async function storeEmbedding(
  tx: TenantTransaction,
  kind: EmbeddingKind,
  input: StoreEmbeddingInput,
) {
  const target = targets[kindSchema.parse(kind)];
  const { ownerId, model, modelVersion, embedding } = storeEmbeddingInputSchema.parse(input);
  const { rowCount } = await tx.execute(sql`
    insert into ${target.table} (${sql.identifier(target.owner.name)}, model, model_version, dimensions, embedding)
    values (${ownerId}, ${model}, ${modelVersion}, ${embeddingModels[model].dimensions}, ${toVector(embedding)}::vector)
    on conflict do nothing
  `);
  return { created: rowCount === 1 };
}

/** The models an owner has an embedding for. */
export function listEmbeddingModels(tx: TenantTransaction, kind: EmbeddingKind, ownerId: string) {
  const target = targets[kindSchema.parse(kind)];
  return tx
    .select({
      model: target.table.model,
      modelVersion: target.table.modelVersion,
      dimensions: target.table.dimensions,
    })
    .from(target.table)
    .where(eq(target.owner, z.uuid().parse(ownerId)))
    .orderBy(target.table.model);
}

export interface EmbeddingMatch {
  ownerId: string;
  /** Cosine distance: 0 is identical, 2 is opposite. */
  distance: number;
}

/**
 * Nearest neighbours within one space, using its HNSW index (migration 0010):
 * the same cast and predicate as the index, so the planner can use it.
 *
 * RLS filters after the index scan, so for a small tenant among many others
 * HNSW could return too few rows. Hence `hnsw.iterative_scan` keeps scanning
 * until enough rows pass, and the explicit tenant filter (next to RLS) makes
 * the intent visible in the query (docs/data-model.md §3.5). With relaxed
 * order the scan may return rows slightly out of order; the outer query sorts.
 */
export async function searchEmbeddings(
  tx: TenantTransaction,
  kind: EmbeddingKind,
  input: SearchEmbeddingsInput,
): Promise<EmbeddingMatch[]> {
  const target = targets[kindSchema.parse(kind)];
  const { model, embedding, limit } = searchEmbeddingsInputSchema.parse(input);
  // Literals, not parameters: the partial index predicate and the cast must be
  // visible to the planner. Both come from the validated model key.
  const dimensions = embeddingModels[model].dimensions;
  const vectorType = sql.raw(`vector(${dimensions})`);
  const modelLiteral = sql.raw(`'${model}'`);

  await tx.execute(sql`set local hnsw.iterative_scan = relaxed_order`);
  const { rows } = await tx.execute<{ owner_id: string; distance: number }>(sql`
    with nearest as materialized (
      select ${sql.identifier(target.owner.name)} as owner_id,
             (embedding::${vectorType}) <=> (${toVector(embedding)}::${vectorType}) as distance
        from ${target.table}
       where model = ${modelLiteral} and dimensions = ${sql.raw(String(dimensions))}
         and tenant_id = ${currentTenantId}
       order by (embedding::${vectorType}) <=> (${toVector(embedding)}::${vectorType})
       limit ${limit}
    )
    select owner_id, distance from nearest order by distance, owner_id
  `);
  return rows.map((row) => ({ ownerId: row.owner_id, distance: Number(row.distance) }));
}
