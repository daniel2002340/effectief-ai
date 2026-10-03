import { isAllowedTransition } from '@effectief/shared';
import { eq } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { TenantTransaction } from '../with-tenant.ts';

export type TransitionErrorCode =
  /** `from → to` is not in the transition list of the table. */
  | 'invalid_transition'
  /** The row no longer had the expected status: someone else changed it first. */
  | 'status_changed'
  /** No such row for this tenant. */
  | 'not_found';

/** A refused status transition; the API maps it to CONFLICT or NOT_FOUND. */
export class TransitionError extends Error {
  override readonly name = 'TransitionError';
  readonly code: TransitionErrorCode;
  readonly table: string;
  readonly from: string;
  readonly to: string;
  /** The status found, for `status_changed`. */
  readonly current: string | undefined;

  constructor(
    code: TransitionErrorCode,
    table: string,
    from: string,
    to: string,
    current?: string,
  ) {
    super(`${table}: ${code} (${from} -> ${to}${current ? `, current ${current}` : ''})`);
    this.code = code;
    this.table = table;
    this.from = from;
    this.to = to;
    this.current = current;
  }
}

export function assertTransition<S extends string>(
  table: string,
  transitions: { readonly [From in S]: readonly S[] },
  from: S,
  to: S,
) {
  if (!isAllowedTransition(transitions, from, to)) {
    throw new TransitionError('invalid_transition', table, from, to);
  }
}

/**
 * Called when the guarded UPDATE (`WHERE id = … AND status = from`) matched
 * no row: tells apart a row that is gone (or of another tenant) from a row
 * whose status changed in the meantime.
 */
export async function missedTransition(
  tx: TenantTransaction,
  target: { name: string; table: PgTable; id: PgColumn; status: PgColumn },
  rowId: string,
  from: string,
  to: string,
): Promise<TransitionError> {
  const [row] = await tx
    .select({ status: target.status })
    .from(target.table)
    .where(eq(target.id, rowId));
  return row
    ? new TransitionError('status_changed', target.name, from, to, String(row.status))
    : new TransitionError('not_found', target.name, from, to);
}
