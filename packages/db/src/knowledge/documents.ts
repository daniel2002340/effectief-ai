import {
  type AddDocumentChunksInput,
  addDocumentChunksInputSchema,
  type CreateDocumentInput,
  createDocumentInputSchema,
  type DocumentStatus,
  documentStatusSchema,
} from '@effectief/shared';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { single } from '../memory/source.ts';
import { documentChunks, documentEntities, documents } from '../schema/index.ts';
import type { TenantTransaction } from '../with-tenant.ts';

// Document knowledge (docs/data-model.md, part C). Extracting text, chunking
// and embedding happen in later jobs; these functions only store the result.

export type DocumentRow = typeof documents.$inferSelect;
export type DocumentChunk = typeof documentChunks.$inferSelect;

const idSchema = z.uuid();

/**
 * Registers a document. The same file (sha256) twice returns the existing
 * document with `created: false`.
 */
export async function createDocument(tx: TenantTransaction, input: CreateDocumentInput) {
  const parsed = createDocumentInputSchema.parse(input);
  const [created] = await tx
    .insert(documents)
    .values(parsed)
    .onConflictDoNothing({ target: [documents.tenantId, documents.sha256] })
    .returning();
  const document =
    created ?? single(await tx.select().from(documents).where(eq(documents.sha256, parsed.sha256)));
  return { document, created: created !== undefined };
}

export async function getDocument(tx: TenantTransaction, documentId: string) {
  const [row] = await tx
    .select()
    .from(documents)
    .where(eq(documents.id, idSchema.parse(documentId)));
  return row;
}

/** Set by the processing job; returns undefined for an unknown document. */
export async function setDocumentStatus(
  tx: TenantTransaction,
  documentId: string,
  status: DocumentStatus,
) {
  const [row] = await tx
    .update(documents)
    .set({ status: documentStatusSchema.parse(status) })
    .where(eq(documents.id, idSchema.parse(documentId)))
    .returning();
  return row;
}

export async function addDocumentChunks(tx: TenantTransaction, input: AddDocumentChunksInput) {
  const { documentId, chunks } = addDocumentChunksInputSchema.parse(input);
  return tx
    .insert(documentChunks)
    .values(chunks.map((chunk) => ({ ...chunk, documentId })))
    .returning();
}

export function listDocumentChunks(tx: TenantTransaction, documentId: string) {
  return tx
    .select()
    .from(documentChunks)
    .where(eq(documentChunks.documentId, idSchema.parse(documentId)))
    .orderBy(asc(documentChunks.ordinal));
}

export async function getDocumentChunk(tx: TenantTransaction, chunkId: string) {
  const [row] = await tx
    .select()
    .from(documentChunks)
    .where(eq(documentChunks.id, idSchema.parse(chunkId)));
  return row;
}

const linkSchema = z.strictObject({ documentId: z.uuid(), entityId: z.uuid() });

/** Marks that an entity occurs in a document; an existing link is kept. */
export async function linkDocumentEntity(tx: TenantTransaction, input: z.input<typeof linkSchema>) {
  const link = linkSchema.parse(input);
  await tx.insert(documentEntities).values(link).onConflictDoNothing();
}

export function listDocumentEntities(tx: TenantTransaction, documentId: string) {
  return tx
    .select({ entityId: documentEntities.entityId })
    .from(documentEntities)
    .where(eq(documentEntities.documentId, idSchema.parse(documentId)))
    .orderBy(asc(documentEntities.entityId));
}
