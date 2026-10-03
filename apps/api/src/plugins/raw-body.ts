import type { FastifyInstance } from 'fastify';

const WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * The one way to register webhook routes. Inside this scope every request
 * body stays a raw Buffer, so signatures are verified on the exact bytes
 * received. Handlers parse the body themselves (with Zod) after that.
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
      scope.addHook('onRoute', (route) => {
        route.config = { ...route.config, rawBody: true };
      });
      await routes(scope);
    },
    { prefix: '/webhooks' },
  );
}
