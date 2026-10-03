import { type SourceRef, sourceRefSchema } from '@effectief/shared';

/** Maps a validated source reference to the source columns (docs/data-model.md §3.6). */
export function sourceColumnsOf(source: SourceRef) {
  const ref = sourceRefSchema.parse(source);
  return {
    sourceType: ref.sourceType,
    sourceEventId: ref.sourceType === 'event' ? ref.sourceEventId : null,
    sourceUserId: ref.sourceType === 'user' ? ref.sourceUserId : null,
    sourceActionId: ref.sourceType === 'action' ? ref.sourceActionId : null,
    aiModel: ref.aiModel ?? null,
    aiTraceId: ref.aiTraceId ?? null,
  };
}

/** For inserts with `returning()`, which always yield exactly one row. */
export function single<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined || rows.length !== 1) {
    throw new Error(`Expected exactly one row, got ${rows.length}`);
  }
  return row;
}
