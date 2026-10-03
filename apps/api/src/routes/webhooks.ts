import type { FastifyInstance } from 'fastify';

/**
 * Webhook endpoints (Nango, Mollie, ...) go here, each with `auth: 'hmac'`
 * and its own verify function. Registered via registerWebhookRoutes().
 */
export async function webhookRoutes(_scope: FastifyInstance): Promise<void> {}
