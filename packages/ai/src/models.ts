// The only place where model IDs live. Changing a model means re-running the
// eval sets and recalibrating thresholds (see CLAUDE.md, AI/RAG).

/**
 * Embedding spaces. The key and `dimensions` are stored on every embedding row
 * (`model`, `dimensions`); the provider model that produced the vector is
 * stored as `model_version`. Vectors are only compared within one space.
 *
 * Embed 5 Pro and Fast share one vector space: documents are embedded with
 * Pro (quality), queries with Fast (latency). Called through the Cohere API
 * directly, not Bedrock (decision #047). Matryoshka output at 1024 dimensions.
 *
 * Adding a space needs a migration: the HNSW index and the check on
 * (model, model_version, dimensions) of each *_embeddings table.
 */
export const embeddingModels = {
  'cohere-embed-v5': {
    provider: 'cohere',
    dimensions: 1024,
    documentVersion: 'embed-v5.0-pro',
    queryVersion: 'embed-v5.0-fast',
  },
} as const;

export type EmbeddingModel = keyof typeof embeddingModels;

/** The space each kind of embedding is written and searched in. */
export const activeEmbeddingModels = {
  fact: 'cohere-embed-v5',
  playbook: 'cohere-embed-v5',
  chunk: 'cohere-embed-v5',
} as const satisfies Record<string, EmbeddingModel>;

export const models = { embedding: embeddingModels } as const;
