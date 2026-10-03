import { z } from 'zod';
import { documentStatuses } from './status.ts';

// Document knowledge (docs/data-model.md, part C). The original file lives in
// object storage (EU), not in Postgres; chunks hold the extracted text.

const documentFile = {
  title: z.string().trim().min(1).max(300),
  storageKey: z.string().min(1).max(500).nullish(),
  mimeType: z
    .string()
    .regex(/^[\w.+-]+\/[\w.+-]+$/)
    .max(200),
  byteSize: z.int().min(0),
  /** Hex sha256 of the original; uploading the same file twice returns the first. */
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/i)
    .transform((hash) => hash.toLowerCase()),
};

export const createDocumentInputSchema = z.discriminatedUnion('origin', [
  z.strictObject({
    origin: z.literal('upload'),
    ...documentFile,
    uploadedByUserId: z.uuid().nullish(),
  }),
  z.strictObject({
    origin: z.literal('connection'),
    ...documentFile,
    connectionId: z.uuid(),
    externalId: z.string().min(1).max(500),
  }),
]);
export type CreateDocumentInput = z.input<typeof createDocumentInputSchema>;

export const documentStatusSchema = z.enum(documentStatuses);

export const documentChunkInputSchema = z.strictObject({
  ordinal: z.int().min(0),
  /** Headings above this chunk, e.g. "Voorwaarden > Betaling". */
  headingPath: z.string().trim().min(1).max(1000).nullish(),
  content: z.string().min(1).max(50_000),
  /** From the tokenizer of the embedding model, never estimated. */
  tokenCount: z.int().min(0),
});

export const addDocumentChunksInputSchema = z.strictObject({
  documentId: z.uuid(),
  chunks: z.array(documentChunkInputSchema).min(1).max(1000),
});
export type AddDocumentChunksInput = z.input<typeof addDocumentChunksInputSchema>;
