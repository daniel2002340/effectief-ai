import { embeddingModels } from '@effectief/ai';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkViolation,
  openTestDatabases,
  permissionDenied,
  type TestTenant,
} from '../test-support.ts';
import { type TenantTransaction, withTenant } from '../with-tenant.ts';
import {
  type EmbeddingKind,
  listEmbeddingModels,
  searchEmbeddings,
  storeEmbedding,
} from './embeddings.ts';
import { dimensions, documentVersion, model, seedKnowledge, unitVector } from './test-fixtures.ts';

// Every embedding row stores its space (model, dimensions) and the provider
// model that produced it (model_version). A vector whose length does not
// match the model is refused by the repository and, for raw SQL, by the
// database.

const db = openTestDatabases();
let tenant: TestTenant;
let world: Awaited<ReturnType<typeof seedKnowledge>>;

beforeAll(async () => {
  tenant = await db.createTenant();
  world = await inTenant((tx) => seedKnowledge(tx, tenant, unitVector(0)));
});
afterAll(() => db.close());

const inTenant = <T>(fn: (tx: TenantTransaction) => Promise<T>) =>
  withTenant(db.app.db, tenant.tenantId, fn);
const vectorLiteral = (values: number[]) => `[${values.join(',')}]`;

type World = typeof world;
const owners: [EmbeddingKind, string, (w: World) => string][] = [
  ['fact', 'fact_embeddings', (w) => w.bareFact.id],
  ['playbook', 'playbook_embeddings', (w) => w.barePlaybook.id],
  ['chunk', 'chunk_embeddings', (w) => w.bareChunk.id],
];

describe('models.ts', () => {
  it('Cohere Embed 5 at 1024 dimensions, Pro for documents and Fast for queries', () => {
    expect(embeddingModels[model]).toEqual({
      provider: 'cohere',
      dimensions: 1024,
      documentVersion: 'embed-v5.0-pro',
      queryVersion: 'embed-v5.0-fast',
    });
  });

  it('matches the model check and the HNSW indexes in the database', async () => {
    const { rows } = await db.app.db.execute<{ table_name: string; definition: string }>(sql`
      select c.relname as table_name, pg_get_constraintdef(k.oid) as definition
        from pg_constraint k join pg_class c on c.oid = k.conrelid
       where k.conname in ('fact_embeddings_model', 'playbook_embeddings_model', 'chunk_embeddings_model')
    `);
    expect(rows).toHaveLength(3);
    for (const [name, config] of Object.entries(embeddingModels)) {
      for (const version of [config.documentVersion, config.queryVersion]) {
        for (const row of rows) {
          expect(row.definition).toContain(
            `(model = '${name}'::text) AND (model_version = '${version}'::text) AND (dimensions = ${config.dimensions})`,
          );
        }
      }
    }

    const indexes = await db.app.db.execute<{ indexdef: string }>(sql`
      select indexdef from pg_indexes where indexname like '%\\_hnsw'
    `);
    for (const [name, config] of Object.entries(embeddingModels)) {
      const forModel = indexes.rows.filter((row) => row.indexdef.includes(`'${name}'::text`));
      expect(forModel).toHaveLength(3);
      for (const row of forModel) {
        expect(row.indexdef).toContain(`vector(${config.dimensions})`);
      }
    }
  });
});

describe.each(owners)('%s embeddings', (kind, table, ownerOf) => {
  const tableId = sql.identifier(table);
  const ownerColumn = sql.identifier(`${kind}_id`);
  const owner = () => ownerOf(world);

  it('store model, version and dimensions with the vector', async () => {
    const { created } = await inTenant((tx) =>
      storeEmbedding(tx, kind, {
        ownerId: owner(),
        model,
        modelVersion: documentVersion,
        embedding: unitVector(7),
      }),
    );
    expect(created).toBe(true);
    expect(await inTenant((tx) => listEmbeddingModels(tx, kind, owner()))).toEqual([
      { model, modelVersion: documentVersion, dimensions },
    ]);
  });

  it('storing again for the same model keeps the first (idempotent backfill)', async () => {
    const again = await inTenant((tx) =>
      storeEmbedding(tx, kind, {
        ownerId: owner(),
        model,
        modelVersion: documentVersion,
        embedding: unitVector(8),
      }),
    );
    expect(again.created).toBe(false);
  });

  it.each([
    ['shorter', dimensions - 1],
    ['longer', dimensions + 1],
    ['a different Matryoshka size', 1536],
  ])('the repository refuses a %s vector', async (_, length) => {
    await expect(
      inTenant((tx) =>
        storeEmbedding(tx, kind, {
          ownerId: owner(),
          model,
          modelVersion: documentVersion,
          embedding: new Array(length).fill(0.01),
        }),
      ),
    ).rejects.toThrow(/dimensies/);
  });

  it('the repository refuses an unknown model or version', async () => {
    await expect(
      inTenant((tx) =>
        storeEmbedding(tx, kind, {
          ownerId: owner(),
          // @ts-expect-error: not a key of embeddingModels
          model: 'titan-embed-v2',
          modelVersion: documentVersion,
          embedding: unitVector(1),
        }),
      ),
    ).rejects.toThrow();
    await expect(
      inTenant((tx) =>
        storeEmbedding(tx, kind, {
          ownerId: owner(),
          model,
          modelVersion: 'embed-v4.0',
          embedding: unitVector(1),
        }),
      ),
    ).rejects.toThrow(/Onbekende versie/);
  });

  it('the database refuses a vector whose length differs from `dimensions`', async () => {
    await expect(
      inTenant((tx) =>
        tx.execute(sql`
          insert into ${tableId} (${ownerColumn}, model, model_version, dimensions, embedding)
          values (${owner()}, ${model}, ${documentVersion}, ${dimensions},
                  ${vectorLiteral(new Array(512).fill(0.1))}::vector)`),
      ),
    ).rejects.toMatchObject(checkViolation);
  });

  it('the database refuses a dimension the model does not have, even if consistent', async () => {
    await expect(
      inTenant((tx) =>
        tx.execute(sql`
          insert into ${tableId} (${ownerColumn}, model, model_version, dimensions, embedding)
          values (${owner()}, ${model}, ${documentVersion}, 512,
                  ${vectorLiteral(new Array(512).fill(0.1))}::vector)`),
      ),
    ).rejects.toMatchObject(checkViolation);
  });

  it('the database refuses an unknown model or version', async () => {
    for (const [name, version] of [
      ['titan-embed-v2', documentVersion],
      [model, 'embed-v4.0'],
    ]) {
      await expect(
        inTenant((tx) =>
          tx.execute(sql`
            insert into ${tableId} (${ownerColumn}, model, model_version, dimensions, embedding)
            values (${owner()}, ${name}, ${version}, ${dimensions},
                    ${vectorLiteral(unitVector(1))}::vector)`),
        ),
      ).rejects.toMatchObject(checkViolation);
    }
  });

  it('embeddings are immutable', async () => {
    await expect(
      inTenant((tx) => tx.execute(sql`update ${tableId} set model_version = model_version`)),
    ).rejects.toMatchObject(permissionDenied);
  });
});

describe('searchEmbeddings', () => {
  it('refuses a query vector of the wrong dimension', async () => {
    await expect(
      inTenant((tx) =>
        searchEmbeddings(tx, 'fact', { model, embedding: new Array(1536).fill(0.01) }),
      ),
    ).rejects.toThrow(/dimensies/);
  });

  it('returns the nearest first, with cosine distance', async () => {
    const hits = await inTenant((tx) =>
      searchEmbeddings(tx, 'fact', { model, embedding: unitVector(0, 7, 0.2) }),
    );
    // world.fact lies along axis 0, bareFact along axis 7 (stored above).
    expect(hits.map((hit) => hit.ownerId)).toEqual([world.fact.id, world.bareFact.id]);
    expect(hits[0]?.distance).toBeLessThan(hits[1]?.distance ?? 0);
  });

  it('uses the HNSW index of the model when the planner prefers an index', async () => {
    const { rows } = await inTenant(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const query = vectorLiteral(unitVector(0));
      // Same SQL shape as searchEmbeddings().
      return tx.execute<{ 'QUERY PLAN': string }>(sql`
        explain (costs off)
        select fact_id from fact_embeddings
         where model = 'cohere-embed-v5' and dimensions = 1024
           and tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
         order by (embedding::vector(1024)) <=> (${query}::vector(1024))
         limit 10`);
    });
    expect(rows.map((row) => row['QUERY PLAN']).join('\n')).toContain(
      'fact_embeddings_cohere_embed_v5_hnsw',
    );
  });

  it('cascades: an embedding disappears with its owner', async () => {
    const countFor = (id: string) =>
      inTenant(async (tx) => {
        const { rows } = await tx.execute<{ n: number }>(
          sql`select count(*)::int as n from document_chunks c
               join chunk_embeddings e on e.chunk_id = c.id where c.document_id = ${id}`,
        );
        return rows[0]?.n;
      });
    expect(await countFor(world.document.id)).toBe(2);
    await inTenant((tx) => tx.execute(sql`delete from documents where id = ${world.document.id}`));
    expect(await countFor(world.document.id)).toBe(0);
    const left = await inTenant((tx) =>
      tx.execute(sql`select 1 from chunk_embeddings where chunk_id = ${world.chunk.id}`),
    );
    expect(left.rows).toEqual([]);
  });
});
