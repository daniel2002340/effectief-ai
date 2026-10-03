import type { FastifyInstance, onRequestHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '../errors.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const requireJson: onRequestHookHandler = async (request) => {
  if (SAFE_METHODS.has(request.method)) return;
  const type = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') throw new AppError('UNSUPPORTED_MEDIA_TYPE');
};

/**
 * CSRF defence (decision #021), next to SameSite=Strict cookies: every
 * request that can change something must be JSON. Browsers cannot send JSON
 * cross-site without a CORS preflight, which this API never grants. HTML
 * forms (urlencoded, multipart, text/plain) and body-less "simple" requests
 * are refused with 415 before any handler runs.
 *
 * Webhooks are exempt: they are not cookie-authenticated, carry their own
 * signature and keep their raw body (registerWebhookRoutes()).
 */
export const jsonOnly = fp(
  async (app: FastifyInstance) => {
    app.addHook('onRoute', (route) => {
      if (route.config?.auth === 'hmac') return;
      const existing = route.onRequest;
      route.onRequest = [
        requireJson,
        ...(existing === undefined ? [] : Array.isArray(existing) ? existing : [existing]),
      ];
    });
  },
  { name: 'json-only' },
);
