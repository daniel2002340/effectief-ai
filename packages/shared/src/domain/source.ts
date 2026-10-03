import { z } from 'zod';

/** Short codes only: model keys and trace ids, never free text. */
const codeSchema = z.string().regex(/^[\w.:/-]{1,200}$/);

const aiFields = {
  /** Key from packages/ai/models.ts when the AI proposed it. */
  aiModel: codeSchema.optional(),
  /** Langfuse trace id. */
  aiTraceId: codeSchema.optional(),
};

/**
 * The source of a piece of knowledge: `sourceType` plus exactly the reference
 * that belongs to it (docs/data-model.md §3.6).
 *
 * `document` is allowed by the database but not yet here: its column arrives
 * with document_chunks (#042).
 */
export const sourceRefSchema = z.discriminatedUnion('sourceType', [
  z.strictObject({ sourceType: z.literal('event'), sourceEventId: z.uuid(), ...aiFields }),
  z.strictObject({ sourceType: z.literal('user'), sourceUserId: z.uuid(), ...aiFields }),
  z.strictObject({ sourceType: z.literal('action'), sourceActionId: z.uuid(), ...aiFields }),
  z.strictObject({ sourceType: z.literal('system'), ...aiFields }),
]);
export type SourceRef = z.infer<typeof sourceRefSchema>;
