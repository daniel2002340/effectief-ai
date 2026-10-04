import type { ReportError } from '@effectief/shared';
import type { FastifyError, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { AppError, codeForStatus, errorBody } from '../errors.ts';
import { toErrorIssues } from '../issues.ts';

/**
 * Every error leaves the API in the same shape: `{ error: { code, message, requestId } }`.
 * Unexpected errors are logged, reported (Sentry, decision #055) and answered
 * with a generic 500, never with details.
 */
export const errorHandler = fp(
  async (app: FastifyInstance, { reportError }: { reportError: ReportError }) => {
    app.addHook('onSend', async (request, reply) => {
      reply.header('x-request-id', request.id);
    });

    app.setNotFoundHandler((request, reply) => {
      reply.status(404).send(errorBody('NOT_FOUND', request.id));
    });

    app.setErrorHandler((error: FastifyError, request, reply) => {
      if (error instanceof AppError) {
        return reply
          .status(error.statusCode)
          .send(
            errorBody(error.code, request.id, { message: error.message, issues: error.issues }),
          );
      }

      if (error instanceof ZodError) {
        return reply
          .status(400)
          .send(
            errorBody('VALIDATION_FAILED', request.id, { issues: toErrorIssues(error.issues) }),
          );
      }

      if (error.validation) {
        const issues = error.validation.map((item) => ({
          message: item.message ?? 'Ongeldige waarde',
          path: item.instancePath.split('/').filter(Boolean),
        }));
        return reply.status(400).send(errorBody('VALIDATION_FAILED', request.id, { issues }));
      }

      const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
      if (status >= 500) {
        request.log.error({ err: error }, 'request failed');
        reportError(error, { requestId: request.id, route: request.routeOptions.url });
        return reply.status(500).send(errorBody('INTERNAL_ERROR', request.id));
      }

      request.log.info({ errorCode: error.code, status }, 'request rejected');
      return reply.status(status).send(errorBody(codeForStatus(status), request.id));
    });
  },
  { name: 'error-handler' },
);
