import type { z } from 'zod';

export class EnvValidationError extends Error {
  readonly variables: string[];

  constructor(variables: string[], details: string) {
    super(`Invalid environment configuration:\n${details}`);
    this.name = 'EnvValidationError';
    this.variables = variables;
  }
}

/**
 * Validates environment variables against a Zod schema. Throws on any missing
 * or invalid value; there are deliberately no fallbacks.
 * Error messages name the variables, never their values.
 */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined>,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (result.success) return result.data;

  const variables = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
  const details = result.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new EnvValidationError(variables, details);
}
