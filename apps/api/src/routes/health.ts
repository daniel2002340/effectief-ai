import type { FastifyInstance } from 'fastify';

/**
 * Liveness only: the process is up and serving requests. Exempt from rate
 * limiting, so it keeps answering when Valkey is unreachable. The release
 * (git SHA) lets the edge's pre-deploy wait for the matching api (#064).
 */
export async function healthRoutes(
  app: FastifyInstance,
  { release }: { release: string },
): Promise<void> {
  app.get('/health', { config: { auth: 'public', rateLimit: false } }, async () => ({
    status: 'ok',
    release,
  }));
}
