export type KnowledgeErrorCode =
  /** No such row for this tenant. */
  | 'not_found'
  /** The row is no longer current: ended, replaced, rejected or retired. */
  | 'not_current';

/**
 * A refused change to knowledge that is not a status transition, such as
 * replacing a fact that was already replaced. The API maps it to NOT_FOUND
 * or CONFLICT, like TransitionError.
 */
export class KnowledgeError extends Error {
  override readonly name = 'KnowledgeError';
  readonly code: KnowledgeErrorCode;
  readonly table: string;
  readonly id: string;

  constructor(code: KnowledgeErrorCode, table: string, id: string) {
    super(`${table}: ${code} (${id})`);
    this.code = code;
    this.table = table;
    this.id = id;
  }
}
