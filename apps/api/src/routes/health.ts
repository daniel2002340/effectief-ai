import type { FastifyInstance } from 'fastify';

/** Liveness only: the process is up and serving requests. */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', { config: { auth: 'public' } }, async () => ({ status: 'ok' }));
}
