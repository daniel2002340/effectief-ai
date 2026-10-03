import { type AuthType, authTypeSchema } from '@effectief/shared';
import type {
  FastifyInstance,
  FastifyRequest,
  onRequestHookHandler,
  preValidationHookHandler,
  RouteOptions,
} from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '../errors.ts';

/**
 * `contract` marks the single Fastify route that serves the oRPC contract.
 * Procedures there require a session by default; public ones are implemented
 * with the explicit `publicProcedure` (see orpc/builders.ts).
 */
type RouteAuth = AuthType | 'contract';

interface HmacConfig {
  /** Verifies the signature against the exact bytes that were received. */
  verify: (request: FastifyRequest, rawBody: Buffer) => boolean | Promise<boolean>;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: RouteAuth;
    hmac?: HmacConfig;
    /** Set by registerWebhookRoutes(); never set this by hand. */
    rawBody?: true;
  }
}

const routeAuthValues: readonly RouteAuth[] = [...authTypeSchema.options, 'contract'];

class RouteAuthError extends Error {
  constructor(route: Pick<RouteOptions, 'method' | 'url'>, reason: string) {
    super(`Route ${String(route.method)} ${route.url}: ${reason}`);
    this.name = 'RouteAuthError';
  }
}

const requireSession: onRequestHookHandler = async () => {
  // There is no session system yet, so nothing can authenticate as a session.
  throw new AppError('UNAUTHORIZED');
};

function requireSignature(hmac: HmacConfig): preValidationHookHandler {
  return async (request) => {
    if (!Buffer.isBuffer(request.body)) throw new AppError('UNAUTHORIZED');
    const valid = await hmac.verify(request, request.body);
    if (!valid) throw new AppError('UNAUTHORIZED');
  };
}

function prepend<T>(hook: T, existing: T | T[] | undefined): T[] {
  if (existing === undefined) return [hook];
  return [hook, ...(Array.isArray(existing) ? existing : [existing])];
}

/**
 * Deny by default: every route must declare `config.auth`. A route without
 * one makes registration fail, so the server cannot start.
 */
export const routeAuth = fp(
  async (app: FastifyInstance) => {
    const hmacRoutes: RouteOptions[] = [];

    app.addHook('onRoute', (route) => {
      const auth = route.config?.auth;
      if (auth === undefined || !routeAuthValues.includes(auth)) {
        throw new RouteAuthError(route, `missing or unknown auth type (${String(auth)})`);
      }

      if (auth === 'session') {
        route.onRequest = prepend(requireSession, route.onRequest);
      }

      if (auth === 'hmac') {
        const hmac = route.config?.hmac;
        if (typeof hmac?.verify !== 'function') {
          throw new RouteAuthError(route, 'auth "hmac" requires config.hmac.verify');
        }
        route.preValidation = prepend(requireSignature(hmac), route.preValidation);
        hmacRoutes.push(route);
      }
    });

    // Webhook scopes mark their routes after this hook has run, so the raw
    // body requirement is checked once all routes are known.
    app.addHook('onReady', async () => {
      for (const route of hmacRoutes) {
        if (route.config?.rawBody !== true) {
          throw new RouteAuthError(
            route,
            'auth "hmac" is only allowed via registerWebhookRoutes()',
          );
        }
      }
    });
  },
  { name: 'route-auth' },
);
