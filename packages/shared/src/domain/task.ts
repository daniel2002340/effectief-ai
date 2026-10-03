import { z } from 'zod';
import { sourceRefSchema } from './source.ts';
import { taskCreatedByValues } from './status.ts';

export const createTaskInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(300),
  notes: z.string().trim().max(5000).nullish(),
  dueAt: z.date().nullish(),
  assigneeUserId: z.uuid().nullish(),
  /** `ai`: proposed on a card and accepted by the user (docs/data-model.md, tasks). */
  createdBy: z.enum(taskCreatedByValues),
  /** The card it came from, when the user accepted a suggested task. */
  originCardId: z.uuid().nullish(),
  entityIds: z.array(z.uuid()).max(50).default([]),
  source: sourceRefSchema,
});
export type CreateTaskInput = z.input<typeof createTaskInputSchema>;
