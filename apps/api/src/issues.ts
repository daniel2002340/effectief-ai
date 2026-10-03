import type { ErrorIssue } from '@effectief/shared';

interface IssueLike {
  message: string;
  path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> | undefined;
}

/** Normalises Zod and Standard Schema issues to the API's issue shape. */
export function toErrorIssues(issues: readonly IssueLike[]): ErrorIssue[] {
  return issues.map((issue) => ({
    message: issue.message,
    path: (issue.path ?? []).map((segment) => {
      const key = typeof segment === 'object' ? segment.key : segment;
      return typeof key === 'number' ? key : String(key);
    }),
  }));
}
