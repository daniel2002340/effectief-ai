import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiEnv } from '../env.ts';
import { toFetchHeaders } from '../http.ts';
import { AUTH_BASE_PATH, type Auth } from './auth.ts';

export interface AuthRouteOptions {
  auth: Auth;
  env: Pick<ApiEnv, 'APP_ORIGIN'>;
  /** Attempts per IP per window on sign-in and sign-up. */
  loginRateLimit: { max: number; timeWindow: string };
}

/** Converts Fastify's request to the Fetch API request Better Auth expects. */
function toFetchRequest(request: FastifyRequest, origin: string): Request {
  const headers = toFetchHeaders(request.headers);
  const hasBody = request.body !== undefined && request.body !== null;
  // The URL is built from configuration, never from the Host header.
  return new Request(new URL(request.url, origin), {
    method: request.method,
    headers,
    ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
  });
}

async function sendFetchResponse(reply: FastifyReply, response: Response) {
  reply.status(response.status);
  for (const [name, value] of response.headers) {
    if (name === 'set-cookie') continue;
    reply.header(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) reply.header('set-cookie', cookies);
  return reply.send(response.body ? await response.text() : null);
}

/**
 * Better Auth's endpoints under /api/auth. `auth: 'public'` because Better
 * Auth checks sessions itself for the endpoints that need one. Sign-in and
 * sign-up get a stricter rate limit than the global one.
 */
export async function authRoutes(
  app: FastifyInstance,
  { auth, env, loginRateLimit }: AuthRouteOptions,
): Promise<void> {
  const handler = async (request: FastifyRequest, reply: FastifyReply) =>
    sendFetchResponse(reply, await auth.handler(toFetchRequest(request, env.APP_ORIGIN)));

  for (const path of ['/sign-in/email', '/sign-up/email']) {
    app.post(
      `${AUTH_BASE_PATH}${path}`,
      { config: { auth: 'public', rateLimit: loginRateLimit } },
      handler,
    );
  }

  app.route({
    method: ['GET', 'POST'],
    url: `${AUTH_BASE_PATH}/*`,
    config: { auth: 'public' },
    handler,
  });
}
