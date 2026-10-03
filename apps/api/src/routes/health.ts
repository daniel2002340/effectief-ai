import type { FastifyInstance } from 'fastify';

/**
 * Liveness only: the process is up and serving requests. Exempt from rate
 * limiting, so it keeps answering when Valkey is unreachable.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', { config: { auth: 'public', rateLimit: false } }, async () => ({
    status: 'ok',
  }));
}
