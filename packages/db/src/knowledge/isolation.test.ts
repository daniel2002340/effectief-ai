import { type SQL, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTask } from '../memory/tasks.ts';
import {
  foreignKeyViolation,
  openTestDatabases,
  permissionDenied,
  rlsViolation,
  type TestTenant,
} from '../test-support.ts';
import { type TenantTransaction, withTenant } from '../with-tenant.ts';
import { getCompanyProfile } from './company-profile.ts';
import {
  addDocumentChunks,
  getDocument,
  getDocumentChunk,
  linkDocumentEntity,
  listDocumentChunks,
} from './documents.ts';
import {
  type EmbeddingKind,
  listEmbeddingModels,
  searchEmbeddings,
  storeEmbedding,
} from './embeddings.ts';
import { createFact, getFact, listCurrentFacts, replaceFact } from './facts.ts';
import { listInsights, upsertInsight } from './insights.ts';
import {
  addPlaybookExample,
  createPlaybook,
  getPlaybook,
  getPlaybookUsage,
  listPlaybookExamples,
} from './playbooks.ts';
import {
  dimensions,
  documentVersion,
  model,
  randomVector,
  seedKnowledge,
  unitVector,
} from './test-fixtures.ts';

// Tenant A must not read, change or delete tenant B's rows in any knowledge
// table, also not with raw SQL or a vector search, and must not link its rows
// to B's rows.

const db = openTestDatabases();
let A: TestTenant;
let B: TestTenant;
let worldA: World;
let worldB: World;

type World = Awaited<ReturnType<typeof seedKnowledge>>;

// A's vectors lie along axis 0, B's along axis 1: a query along axis 1 is an
// exact match for B and far from everything of A.
const axisA = 0;
const axisB = 1;

beforeAll(async () => {
  A = await db.createTenant();
  B = await db.createTenant();
  worldA = await withTenant(db.app.db, A.tenantId, (tx) => seedKnowledge(tx, A, unitVector(axisA)));
  worldB = await withTenant(db.app.db, B.tenantId, (tx) => seedKnowledge(tx, B, unitVector(axisB)));
});

afterAll(() => db.close());

const asA = <T>(fn: (tx: TenantTransaction) => Promise<T>) => withTenant(db.app.db, A.tenantId, fn);
const asB = <T>(fn: (tx: TenantTransaction) => Promise<T>) => withTenant(db.app.db, B.tenantId, fn);
const rows = (result: { rows: unknown[] }) => result.rows as Record<string, unknown>[];
const vectorLiteral = (values: number[]) => `[${values.join(',')}]`;

interface TableCase {
  table: string;
  /** A no-op UPDATE on a column the app may update, or null when it may update nothing. */
  update: string | null;
  canDelete: boolean;
  /** Inserts a row for `tenant`, referencing that tenant's world. */
  insert: (tenantId: string, world: World) => SQL;
}

const embeddingInsert =
  (table: string, ownerColumn: string, owner: (world: World) => string) => (t: string, w: World) =>
    sql`insert into ${sql.identifier(table)} (tenant_id, ${sql.identifier(ownerColumn)}, model, model_version, dimensions, embedding)
        values (${t}, ${owner(w)}, ${model}, ${documentVersion}, ${dimensions}, ${vectorLiteral(unitVector(5))}::vector)`;

const tables: TableCase[] = [
  {
    table: 'facts',
    update: 'status = status',
    canDelete: false,
    insert: (t, w) =>
      sql`insert into facts (tenant_id, entity_id, statement, source_type)
          values (${t}, ${w.entity.id}, 'X', 'system')`,
  },
  {
    table: 'fact_embeddings',
    update: null,
    canDelete: true,
    insert: embeddingInsert('fact_embeddings', 'fact_id', (w) => w.bareFact.id),
  },
  {
    table: 'playbooks',
    update: 'status = status',
    canDelete: false,
    insert: (t) =>
      sql`insert into playbooks (tenant_id, title, trigger_description, instruction, scope, source_type)
          values (${t}, 'X', 'X', 'X', 'company', 'system')`,
  },
  {
    table: 'playbook_examples',
    update: null,
    canDelete: true,
    insert: (t, w) =>
      sql`insert into playbook_examples (tenant_id, playbook_id, source_event_id, input_excerpt, output_text)
          values (${t}, ${w.playbook.id}, ${w.event.id}, 'X', 'Y')`,
  },
  {
    table: 'playbook_embeddings',
    update: null,
    canDelete: true,
    insert: embeddingInsert('playbook_embeddings', 'playbook_id', (w) => w.barePlaybook.id),
  },
  {
    table: 'documents',
    update: 'title = title',
    canDelete: true,
    insert: (t) =>
      sql`insert into documents (tenant_id, title, origin, mime_type, byte_size, sha256)
          values (${t}, 'X', 'upload', 'text/plain', 1, ${'a'.repeat(64)})`,
  },
  {
    table: 'document_chunks',
    update: null,
    canDelete: false,
    insert: (t, w) =>
      sql`insert into document_chunks (tenant_id, document_id, ordinal, content, token_count)
          values (${t}, ${w.document.id}, 99, 'X', 1)`,
  },
  {
    table: 'chunk_embeddings',
    update: null,
    canDelete: true,
    insert: embeddingInsert('chunk_embeddings', 'chunk_id', (w) => w.bareChunk.id),
  },
  {
    table: 'document_entities',
    update: null,
    canDelete: true,
    insert: (t, w) =>
      sql`insert into document_entities (tenant_id, document_id, entity_id)
          values (${t}, ${w.document.id}, ${w.entity.id})`,
  },
  {
    table: 'company_profile',
    update: 'trade_name = trade_name',
    canDelete: false,
    insert: (t) =>
      sql`insert into company_profile (tenant_id, trade_name, sector) values (${t}, 'X', 'other')`,
  },
  {
    table: 'insights',
    update: 'payload = payload',
    canDelete: true,
    insert: (t) =>
      sql`insert into insights (tenant_id, kind, payload, expires_at)
          values (${t}, 'open_quotes', '{}', now() + interval '1 day')`,
  },
];

const countAll = (table: string) => sql`select count(*)::int as n from ${sql.identifier(table)}`;

describe.each(tables)('$table', ({ table, update, canDelete, insert }) => {
  const tableId = sql.identifier(table);

  it('a tenant sees only its own rows', async () => {
    const seen = await asA((tx) => tx.execute(sql`select distinct tenant_id from ${tableId}`));
    expect(rows(seen)).toEqual([{ tenant_id: A.tenantId }]);
  });

  it('a tenant cannot read another tenant with raw SQL', async () => {
    const seen = await asA((tx) =>
      tx.execute(sql`select * from ${tableId} where tenant_id = ${B.tenantId}`),
    );
    expect(seen.rows).toEqual([]);
  });

  it('a tenant cannot update another tenant', async () => {
    if (update === null) {
      await expect(
        asA((tx) => tx.execute(sql`update ${tableId} set tenant_id = tenant_id`)),
      ).rejects.toMatchObject(permissionDenied);
      return;
    }
    const result = await asA((tx) =>
      tx.execute(sql`update ${tableId} set ${sql.raw(update)} where tenant_id = ${B.tenantId}`),
    );
    expect(result.rowCount).toBe(0);
  });

  it('a tenant cannot delete another tenant', async () => {
    const before = rows(await asB((tx) => tx.execute(countAll(table))));
    const attempt = asA((tx) =>
      tx.execute(sql`delete from ${tableId} where tenant_id = ${B.tenantId}`),
    );
    if (canDelete) expect((await attempt).rowCount).toBe(0);
    else await expect(attempt).rejects.toMatchObject(permissionDenied);
    expect(rows(await asB((tx) => tx.execute(countAll(table))))).toEqual(before);
  });

  it('a tenant cannot insert a row for another tenant', async () => {
    await expect(asA((tx) => tx.execute(insert(B.tenantId, worldB)))).rejects.toMatchObject(
      rlsViolation,
    );
  });

  it('without tenant context nothing is visible and nothing can be written', async () => {
    expect(rows(await db.app.db.execute(countAll(table)))).toEqual([{ n: 0 }]);
    await expect(db.app.db.execute(insert(A.tenantId, worldA))).rejects.toThrow();
  });
});

describe('the view playbook_usage', () => {
  it('shows only own playbooks (security_invoker)', async () => {
    const seen = await asA((tx) => tx.execute(sql`select distinct tenant_id from playbook_usage`));
    expect(rows(seen)).toEqual([{ tenant_id: A.tenantId }]);
    expect(await asA((tx) => getPlaybookUsage(tx, worldB.playbook.id))).toBeUndefined();
    expect(await asA((tx) => getPlaybookUsage(tx, worldA.playbook.id))).toEqual({
      timesApplied: 0,
      lastAppliedAt: null,
    });
  });
});

describe('vector search', () => {
  const kinds: [EmbeddingKind, (world: World) => string][] = [
    ['fact', (w) => w.fact.id],
    ['playbook', (w) => w.playbook.id],
    ['chunk', (w) => w.chunk.id],
  ];

  describe.each(kinds)('%s embeddings', (kind, owner) => {
    // The query is B's exact vector: without isolation, B's row is the top hit.
    const query = () => unitVector(axisB);

    it('B finds its own row as exact match', async () => {
      const hits = await asB((tx) => searchEmbeddings(tx, kind, { model, embedding: query() }));
      expect(hits[0]).toEqual({ ownerId: owner(worldB), distance: 0 });
    });

    it('A never gets B’s rows, also not for B’s exact vector', async () => {
      const hits = await asA((tx) => searchEmbeddings(tx, kind, { model, embedding: query() }));
      expect(hits.map((hit) => hit.ownerId)).toEqual([owner(worldA)]);
    });

    it('A never gets B’s rows when the search goes through the HNSW index', async () => {
      const hits = await asA(async (tx) => {
        await tx.execute(sql`set local enable_seqscan = off`);
        return searchEmbeddings(tx, kind, { model, embedding: query() });
      });
      expect(hits.map((hit) => hit.ownerId)).toEqual([owner(worldA)]);
    });

    it('a raw nearest-neighbour query as A returns only A’s rows', async () => {
      const table = sql.identifier(`${kind}_embeddings`);
      const seen = await asA((tx) =>
        tx.execute(
          sql`select tenant_id from ${table}
               order by embedding <=> ${vectorLiteral(query())}::vector limit 10`,
        ),
      );
      expect(rows(seen)).toEqual([{ tenant_id: A.tenantId }]);
    });

    it('without tenant context a search finds nothing', async () => {
      const hits = await db.app.db.transaction((tx) =>
        searchEmbeddings(tx, kind, { model, embedding: query() }),
      );
      expect(hits).toEqual([]);
    });
  });

  it('a small tenant among many rows of another tenant still gets its match', async () => {
    // RLS filters after the index scan. C has one fact; D has 300 right next
    // to the query. With ef_search 10 a plain HNSW scan only sees D's rows and
    // returns nothing for C; the iterative scan keeps going until C's row passes.
    const C = await db.createTenant();
    const D = await db.createTenant();
    const query = randomVector(1);
    const worldC = await withTenant(db.app.db, C.tenantId, (tx) =>
      seedKnowledge(tx, C, randomVector(2)),
    );
    await withTenant(db.app.db, D.tenantId, async (tx) => {
      const worldD = await seedKnowledge(tx, D, query);
      for (let i = 0; i < 300; i++) {
        const fact = await createFact(tx, {
          entityId: worldD.entity.id,
          statement: `Feit ${i}`,
          source: { sourceType: 'system' },
        });
        await storeEmbedding(tx, 'fact', {
          ownerId: fact.id,
          model,
          modelVersion: documentVersion,
          embedding: randomVector(100 + i, { vector: query, noise: 0.05 }),
        });
      }
    });

    const hits = await withTenant(db.app.db, C.tenantId, async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      await tx.execute(sql`set local hnsw.ef_search = 10`);
      return searchEmbeddings(tx, 'fact', { model, embedding: query, limit: 5 });
    });
    expect(hits.map((hit) => hit.ownerId)).toEqual([worldC.fact.id]);
  });
});

describe('repository reads across tenants', () => {
  it('return nothing for ids of another tenant', async () => {
    await asA(async (tx) => {
      expect(await getFact(tx, worldB.fact.id)).toBeUndefined();
      expect(await listCurrentFacts(tx, worldB.entity.id)).toEqual([]);
      expect(await getPlaybook(tx, worldB.playbook.id)).toBeUndefined();
      expect(await listPlaybookExamples(tx, worldB.playbook.id)).toEqual([]);
      expect(await getDocument(tx, worldB.document.id)).toBeUndefined();
      expect(await getDocumentChunk(tx, worldB.chunk.id)).toBeUndefined();
      expect(await listDocumentChunks(tx, worldB.document.id)).toEqual([]);
      expect(await listEmbeddingModels(tx, 'fact', worldB.fact.id)).toEqual([]);
      expect(await listInsights(tx, { entityId: worldB.entity.id })).toEqual([]);
    });
  });

  it('the company profile is the own one', async () => {
    expect((await asA(getCompanyProfile))?.tenantId).toBe(A.tenantId);
    expect((await asB(getCompanyProfile))?.tenantId).toBe(B.tenantId);
  });
});

describe('links between tenants', () => {
  // Composite foreign keys on (tenant_id, …): a row of A can only point to rows of A.
  it('a fact of A cannot be about an entity of B or cite a chunk of B', async () => {
    await expect(
      asA((tx) =>
        createFact(tx, {
          entityId: worldB.entity.id,
          statement: 'X',
          source: { sourceType: 'system' },
        }),
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
    await expect(
      asA((tx) =>
        createFact(tx, {
          entityId: worldA.entity.id,
          statement: 'X',
          source: { sourceType: 'document', sourceChunkId: worldB.chunk.id },
        }),
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
  });

  it('other knowledge of A cannot cite a chunk of B', async () => {
    await expect(
      asA((tx) =>
        createTask(tx, {
          title: 'X',
          createdBy: 'ai',
          source: { sourceType: 'document', sourceChunkId: worldB.chunk.id },
        }),
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
  });

  it('A cannot replace a fact of B', async () => {
    await expect(
      asA((tx) =>
        replaceFact(tx, {
          factId: worldB.fact.id,
          statement: 'X',
          actor: { type: 'user', userId: A.userId },
        }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a playbook of A cannot be scoped to a customer or member of B', async () => {
    await expect(
      asA((tx) =>
        createPlaybook(tx, {
          title: 'X',
          triggerDescription: 'X',
          instruction: 'X',
          scope: { scope: 'customer', scopeEntityId: worldB.entity.id },
          source: { sourceType: 'system' },
        }),
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
    await expect(
      asA((tx) =>
        createPlaybook(tx, {
          title: 'X',
          triggerDescription: 'X',
          instruction: 'X',
          scope: { scope: 'user', scopeUserId: B.userId },
          source: { sourceType: 'system' },
        }),
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
  });

  it('an example of A cannot belong to a playbook or event of B', async () => {
    await expect(
      asA((tx) =>
        addPlaybookExample(tx, {
          playbookId: worldB.playbook.id,
          sourceEventId: worldA.event.id,
          inputExcerpt: 'X',
          outputText: 'Y',
        }),
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
    await expect(
      asA((tx) =>
        addPlaybookExample(tx, {
          playbookId: worldA.playbook.id,
          sourceEventId: worldB.event.id,
          inputExcerpt: 'X',
          outputText: 'Y',
        }),
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
  });

  it('an embedding of A cannot belong to an owner of B', async () => {
    await expect(
      asA((tx) =>
        storeEmbedding(tx, 'fact', {
          ownerId: worldB.bareFact.id,
          model,
          modelVersion: documentVersion,
          embedding: unitVector(3),
        }),
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
  });

  it('documents of A cannot get chunks or entities of B', async () => {
    await expect(
      asA((tx) =>
        addDocumentChunks(tx, {
          documentId: worldB.document.id,
          chunks: [{ ordinal: 5, content: 'X', tokenCount: 1 }],
        }),
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
    await expect(
      asA((tx) =>
        linkDocumentEntity(tx, { documentId: worldA.document.id, entityId: worldB.entity.id }),
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
  });

  it('an insight of A cannot be about an entity of B', async () => {
    await expect(
      asA((tx) =>
        upsertInsight(tx, {
          kind: 'payment_behaviour',
          entityId: worldB.entity.id,
          payload: { invoiceCount: 1, averageDaysLate: 3 },
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ),
    ).rejects.toMatchObject(foreignKeyViolation);
  });

  it('an action of A cannot follow a playbook of B', async () => {
    await expect(
      asA((tx) => tx.execute(sql`update actions set playbook_id = ${worldB.playbook.id}`)),
    ).rejects.toMatchObject(permissionDenied);
  });
});
