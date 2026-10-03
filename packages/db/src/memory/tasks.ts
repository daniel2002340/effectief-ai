import {
  type CreateTaskInput,
  createTaskInputSchema,
  type TaskStatus,
  taskStatuses,
} from '@effectief/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { taskEntities, tasks } from '../schema/index.ts';
import type { TenantTransaction } from '../with-tenant.ts';
import { single, sourceColumnsOf } from './source.ts';

export type Task = typeof tasks.$inferSelect;

/** Creates a task and links it to its entities in the caller's transaction. */
export async function createTask(tx: TenantTransaction, input: CreateTaskInput) {
  const { entityIds, source, ...task } = createTaskInputSchema.parse(input);
  const created = single(
    await tx
      .insert(tasks)
      .values({ ...task, ...sourceColumnsOf(source) })
      .returning(),
  );
  const unique = [...new Set(entityIds)];
  if (unique.length > 0) {
    await tx
      .insert(taskEntities)
      .values(unique.map((entityId) => ({ taskId: created.id, entityId })));
  }
  return { task: created, entityIds: unique };
}

export async function getTask(tx: TenantTransaction, taskId: string) {
  const [row] = await tx
    .select()
    .from(tasks)
    .where(eq(tasks.id, z.uuid().parse(taskId)));
  return row;
}

/** Earliest due first; tasks without a due date last. */
export function listTasks(tx: TenantTransaction, status: TaskStatus = 'open') {
  return tx
    .select()
    .from(tasks)
    .where(eq(tasks.status, z.enum(taskStatuses).parse(status)))
    .orderBy(sql`${tasks.dueAt} asc nulls last`, asc(tasks.id));
}
