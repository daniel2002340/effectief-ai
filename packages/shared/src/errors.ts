import { z } from 'zod';

export const errorCodeSchema = z.enum([
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
});
export type ErrorIssue = z.infer<typeof errorIssueSchema>;

/** The single shape of every error response the API returns. */
export const errorResponseSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    requestId: z.string(),
    issues: z.array(errorIssueSchema).optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
