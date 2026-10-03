import type { FastifyInstance } from 'fastify';
import { errorBody } from '../errors.ts';

/** Own limit for webhook bodies, independent of the API's general body limit. */
export const WEBHOOK_BODY_LIMIT_BYTES = 512 * 1024;

/**
 * The one way to register webhook routes. Inside this scope every request
 * body stays a raw Buffer, so signatures are verified on the exact bytes
 * received. Handlers parse the body themselves (with Zod) after that.
 *
 * Unknown paths under /webhooks answer 401 rather than 404, so the scope does
 * not reveal which webhook endpoints exist.
 */
export async function registerWebhookRoutes(
  app: FastifyInstance,
  routes: (scope: FastifyInstance) => void | Promise<void>,
): Promise<void> {
  await app.register(
    async (scope) => {
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser(
        '*',
        { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT_BYTES },
        (_request, body, done) => done(null, body),
      );
      scope.setNotFoundHandler((request, reply) => {
        reply.status(401).send(errorBody('UNAUTHORIZED', request.id));
      });
      scope.addHook('onRoute', (route) => {
        route.config = { ...route.config, rawBody: true };
      });
      await routes(scope);
    },
    { prefix: '/webhooks' },
  );
}
