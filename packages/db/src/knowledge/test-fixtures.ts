import { createHash, randomUUID } from 'node:crypto';
import { embeddingModels } from '@effectief/ai';
import { createEntity } from '../memory/entities.ts';
import { recordEvent } from '../memory/events.ts';
import type { TestTenant } from '../test-support.ts';
import type { TenantTransaction } from '../with-tenant.ts';
import { upsertCompanyProfile } from './company-profile.ts';
import { addDocumentChunks, createDocument, linkDocumentEntity } from './documents.ts';
import { storeEmbedding } from './embeddings.ts';
import { confirmFact, createFact } from './facts.ts';
import { upsertInsight } from './insights.ts';
import { addPlaybookExample, createPlaybook } from './playbooks.ts';

// Test data for the knowledge tables: an entity with a confirmed fact, a
// playbook with an example, a document with chunks, embeddings for all three,
// a company profile and insights.

export const model = 'cohere-embed-v5' as const;
export const dimensions = embeddingModels[model].dimensions;
export const documentVersion = embeddingModels[model].documentVersion;

/** A unit vector along axis `axis`, optionally tilted a little towards `towards`. */
export function unitVector(axis: number, towards?: number, tilt = 0.1): number[] {
  const values = new Array<number>(dimensions).fill(0);
  values[axis] = 1;
  if (towards !== undefined) values[towards] = tilt;
  const norm = Math.hypot(...values);
  return values.map((value) => value / norm);
}

/**
 * A deterministic pseudo-random unit vector (seeded LCG), optionally close to
 * `near`. Realistic data for HNSW tests: exactly orthogonal vectors make a
 * degenerate graph in which a node can become unreachable.
 */
export function randomVector(seed: number, near?: { vector: number[]; noise: number }) {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648 - 0.5;
  };
  const values = Array.from(
    { length: dimensions },
    (_, i) => (near ? (near.vector[i] ?? 0) : 0) + (near ? near.noise : 1) * next(),
  );
  const norm = Math.hypot(...values);
  return values.map((value) => value / norm);
}

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export async function seedKnowledge(
  tx: TenantTransaction,
  { userId }: TestTenant,
  embedding: number[] = unitVector(0),
) {
  const entity = await createEntity(tx, { type: 'contact', name: 'Jan Jansen' });
  const { event } = await recordEvent(tx, {
    event: {
      source: 'gmail',
      externalId: `message-${randomUUID()}`,
      type: 'email.received',
      occurredAt: new Date(),
      payload: {},
    },
  });
  const proposed = await createFact(tx, {
    entityId: entity.id,
    statement: 'Wil altijd ’s ochtends gebeld worden',
    attribute: 'preferred_contact_time',
    source: { sourceType: 'event', sourceEventId: event.id },
  });
  const { fact } = await confirmFact(tx, {
    factId: proposed.id,
    actor: { type: 'user', userId },
  });
  /** Without an embedding, for insert tests. */
  const bareFact = await createFact(tx, {
    entityId: entity.id,
    statement: 'Heeft een warmtepomp uit 2019',
    source: { sourceType: 'system' },
  });
  const playbook = await createPlaybook(tx, {
    title: 'Warmtepomp-offerte',
    triggerDescription: 'Offerteaanvraag voor een warmtepomp',
    instruction: 'Vraag altijd naar het bouwjaar van de woning',
    scope: { scope: 'customer', scopeEntityId: entity.id },
    source: { sourceType: 'event', sourceEventId: event.id },
  });
  const barePlaybook = await createPlaybook(tx, {
    title: 'Snoeien',
    triggerDescription: 'Vraag om snoeiwerk',
    instruction: 'Noem de prijs per uur',
    scope: { scope: 'company' },
    source: { sourceType: 'system' },
  });
  const example = await addPlaybookExample(tx, {
    playbookId: playbook.id,
    sourceEventId: event.id,
    inputExcerpt: 'Kunt u een offerte sturen voor {product}?',
    outputText: 'Beste {klantnaam}, wat is het bouwjaar van uw woning?',
  });
  const { document } = await createDocument(tx, {
    origin: 'upload',
    title: 'Algemene voorwaarden',
    mimeType: 'application/pdf',
    byteSize: 1234,
    sha256: sha256(randomUUID()),
    uploadedByUserId: userId,
  });
  const [chunk, bareChunk] = await addDocumentChunks(tx, {
    documentId: document.id,
    chunks: [
      { ordinal: 0, content: 'Betaling binnen 14 dagen.', tokenCount: 6 },
      { ordinal: 1, content: 'Garantie van twee jaar.', tokenCount: 5 },
    ],
  });
  if (!chunk || !bareChunk) throw new Error('Expected two chunks');
  await linkDocumentEntity(tx, { documentId: document.id, entityId: entity.id });

  for (const [kind, ownerId] of [
    ['fact', fact.id],
    ['playbook', playbook.id],
    ['chunk', chunk.id],
  ] as const) {
    await storeEmbedding(tx, kind, {
      ownerId,
      model,
      modelVersion: documentVersion,
      embedding,
    });
  }

  const profile = await upsertCompanyProfile(tx, {
    tradeName: 'Jansen Installatie',
    sector: 'installation',
    toneOfVoice: 'je, informeel',
  });
  const insight = await upsertInsight(tx, {
    kind: 'payment_behaviour',
    entityId: entity.id,
    payload: { invoiceCount: 4, averageDaysLate: 12 },
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return {
    entity,
    event,
    fact,
    bareFact,
    playbook,
    barePlaybook,
    example,
    document,
    chunk,
    bareChunk,
    embedding,
    profile,
    insight,
  };
}
