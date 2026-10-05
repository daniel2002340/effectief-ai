import type { ErrorResponse, ReportError } from '@effectief/shared';
import { ValidationError } from '@orpc/contract';
import { OpenAPIHandler } from '@orpc/openapi/fastify';
import { ORPCError, onError } from '@orpc/server';
import type { FastifyInstance } from 'fastify';
import { AppError, codeForStatus, errorBody } from '../errors.ts';
import { toFetchHeaders } from '../http.ts';
import { toErrorIssues } from '../issues.ts';
import type { ApiContext } from './builders.ts';
import type { ApiRouter } from './router.ts';

const API_PREFIX = '/api';

function encodeError(error: ORPCError<string, unknown>): ErrorResponse {
  // The request id is filled in by the root interceptor below.
  if (error.cause instanceof ValidationError) {
    return errorBody('VALIDATION_FAILED', '', { issues: toErrorIssues(error.cause.issues) });
  }
  return errorBody(codeForStatus(error.status), '');
}

function isErrorResponse(body: unknown): body is ErrorResponse {
  return typeof body === 'object' && body !== null && 'error' in body;
}

export async function orpcRoutes(
  app: FastifyInstance,
  { router, reportError }: { router: ApiRouter; reportError: ReportError },
): Promise<void> {
  const handler = new OpenAPIHandler<ApiContext>(router, {
    customErrorResponseBodyEncoder: encodeError,
    rootInterceptors: [
      async ({ next, context }) => {
        const result = await next();
        if (result.matched && isErrorResponse(result.response.body)) {
          result.response.body.error.requestId = context.requestId;
        }
        return result;
      },
    ],
    interceptors: [
      // The handler answers errors itself, so the Fastify error handler never
      // sees them: unexpected ones are logged and reported here (decision #055).
      onError((error, { context, request }) => {
        const status = (error as { status?: number }).status ?? 500;
        if (status < 500) return;
        // oRPC wraps an unexpected error; report the original, with its own stack.
        const original = error instanceof ORPCError && error.cause ? error.cause : error;
        context.log.error({ err: original }, 'procedure failed');
        reportError(original, { requestId: context.requestId, route: request.url.pathname });
      }),
    ],
  });

  app.all(`${API_PREFIX}/*`, { config: { auth: 'contract' } }, async (request, reply) => {
    const { matched } = await handler.handle(request, reply, {
      prefix: API_PREFIX,
      context: {
        requestId: request.id,
        log: request.log,
        headers: toFetchHeaders(request.headers),
      },
    });
    if (!matched) throw new AppError('NOT_FOUND');
    return reply;
  });
}
