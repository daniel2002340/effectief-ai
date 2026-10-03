import {
  type AddPlaybookExampleInput,
  addPlaybookExampleInputSchema,
  type CreatePlaybookInput,
  type CreatePlaybookVersionInput,
  createPlaybookInputSchema,
  createPlaybookVersionInputSchema,
  type PlaybookScopeInput,
  type PlaybookStatus,
  playbookStatuses,
  playbookTransitions,
  type ReviewPlaybookInput,
  reviewPlaybookInputSchema,
} from '@effectief/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { writeAudit } from '../feed/audit.ts';
import { assertTransition, missedTransition } from '../feed/transition.ts';
import { single, sourceColumnsOf } from '../memory/source.ts';
import { playbookExamples, playbooks } from '../schema/index.ts';
import type { TenantTransaction } from '../with-tenant.ts';
import { KnowledgeError } from './errors.ts';

// Playbooks are never edited (docs/data-model.md, playbooks): a change is a
// new version that retires the previous one when a user confirms it.

export type Playbook = typeof playbooks.$inferSelect;

const idSchema = z.uuid();
const playbookTarget = {
  name: 'playbooks',
  table: playbooks,
  id: playbooks.id,
  status: playbooks.status,
};

function scopeColumns(scope: PlaybookScopeInput) {
  return {
    scope: scope.scope,
    scopeUserId: scope.scope === 'user' ? scope.scopeUserId : null,
    scopeEntityId: scope.scope === 'customer' ? scope.scopeEntityId : null,
  };
}

/** Always `proposed`, version 1. */
export async function createPlaybook(tx: TenantTransaction, input: CreatePlaybookInput) {
  const { scope, source, ...content } = createPlaybookInputSchema.parse(input);
  return single(
    await tx
      .insert(playbooks)
      .values({ ...content, ...scopeColumns(scope), ...sourceColumnsOf(source) })
      .returning(),
  );
}

/**
 * Proposes a new version of a confirmed playbook: same scope, version + 1.
 * The old version stays in force until the new one is confirmed.
 */
export async function createPlaybookVersion(
  tx: TenantTransaction,
  input: CreatePlaybookVersionInput,
) {
  const { supersedesId, source, ...content } = createPlaybookVersionInputSchema.parse(input);
  const previous = await getPlaybook(tx, supersedesId);
  if (!previous) throw new KnowledgeError('not_found', 'playbooks', supersedesId);
  if (previous.status !== 'confirmed') {
    throw new KnowledgeError('not_current', 'playbooks', supersedesId);
  }
  return single(
    await tx
      .insert(playbooks)
      .values({
        ...content,
        scope: previous.scope,
        scopeUserId: previous.scopeUserId,
        scopeEntityId: previous.scopeEntityId,
        version: previous.version + 1,
        supersedesId,
        ...sourceColumnsOf(source),
      })
      .returning(),
  );
}

export async function getPlaybook(tx: TenantTransaction, playbookId: string) {
  const [row] = await tx
    .select()
    .from(playbooks)
    .where(eq(playbooks.id, idSchema.parse(playbookId)));
  return row;
}

export function listPlaybooks(tx: TenantTransaction, status: PlaybookStatus = 'confirmed') {
  return tx
    .select()
    .from(playbooks)
    .where(eq(playbooks.status, z.enum(playbookStatuses).parse(status)))
    .orderBy(asc(playbooks.createdAt), asc(playbooks.id));
}

/** One guarded status change with its audit entry (decision #044). */
async function transitionPlaybook(
  tx: TenantTransaction,
  { playbookId, actor, context }: z.output<typeof reviewPlaybookInputSchema>,
  from: PlaybookStatus,
  to: Exclude<PlaybookStatus, 'proposed'>,
) {
  assertTransition('playbooks', playbookTransitions, from, to);
  const confirming = to === 'confirmed';
  const [playbook] = await tx
    .update(playbooks)
    .set({
      status: to,
      ...(confirming ? { confirmedAt: sql`now()`, confirmedByUserId: actor.userId } : {}),
    })
    .where(and(eq(playbooks.id, playbookId), eq(playbooks.status, from)))
    .returning();
  if (!playbook) throw await missedTransition(tx, playbookTarget, playbookId, from, to);
  await writeAudit(tx, {
    actor,
    context,
    action: `playbook.${to}`,
    objectType: 'playbooks',
    objectId: playbook.id,
    fromStatus: from,
    toStatus: to,
    metadata: { scope: playbook.scope, version: playbook.version },
  });
  return playbook;
}

/**
 * A user confirms a proposed playbook. A new version retires the version it
 * supersedes in the same transaction; if that one is no longer confirmed
 * (another version won), the whole confirmation fails.
 */
export async function confirmPlaybook(tx: TenantTransaction, input: ReviewPlaybookInput) {
  const review = reviewPlaybookInputSchema.parse(input);
  const playbook = await transitionPlaybook(tx, review, 'proposed', 'confirmed');
  const retired = playbook.supersedesId
    ? await transitionPlaybook(
        tx,
        { ...review, playbookId: playbook.supersedesId },
        'confirmed',
        'retired',
      )
    : undefined;
  return { playbook, retired };
}

export function rejectPlaybook(tx: TenantTransaction, input: ReviewPlaybookInput) {
  return transitionPlaybook(tx, reviewPlaybookInputSchema.parse(input), 'proposed', 'rejected');
}

/** A user withdraws a confirmed playbook. */
export function retirePlaybook(tx: TenantTransaction, input: ReviewPlaybookInput) {
  return transitionPlaybook(tx, reviewPlaybookInputSchema.parse(input), 'confirmed', 'retired');
}

export async function addPlaybookExample(tx: TenantTransaction, input: AddPlaybookExampleInput) {
  const example = addPlaybookExampleInputSchema.parse(input);
  return single(await tx.insert(playbookExamples).values(example).returning());
}

export function listPlaybookExamples(tx: TenantTransaction, playbookId: string) {
  return tx
    .select()
    .from(playbookExamples)
    .where(eq(playbookExamples.playbookId, idSchema.parse(playbookId)))
    .orderBy(asc(playbookExamples.createdAt), asc(playbookExamples.id));
}

/** How often the playbook was applied (executed actions), from the view playbook_usage. */
export async function getPlaybookUsage(tx: TenantTransaction, playbookId: string) {
  const { rows } = await tx.execute<{ times_applied: number; last_applied_at: string | null }>(
    sql`select times_applied, last_applied_at from playbook_usage
         where playbook_id = ${idSchema.parse(playbookId)}`,
  );
  const [row] = rows;
  if (!row) return undefined;
  return {
    timesApplied: row.times_applied,
    lastAppliedAt: row.last_applied_at === null ? null : new Date(row.last_applied_at),
  };
}
