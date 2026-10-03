import type { AnyContractRouter } from '@orpc/contract';
import {
  type Implementer,
  type ImplementerInternalWithMiddlewares,
  implement,
  ORPCError,
  type RouterImplementer,
} from '@orpc/server';
import type { FastifyBaseLogger } from 'fastify';
import type { SessionContext } from '../auth/auth.ts';

export interface ApiContext {
  requestId: string;
  log: FastifyBaseLogger;
  /** The request's headers, so the session middleware can read the cookie. */
  headers: Headers;
}

interface SessionApiContext extends ApiContext {
  session: SessionContext;
}

/** Looks up the session for a request; null when there is none. */
export type SessionResolver = (headers: Headers) => Promise<SessionContext | null>;

export interface Builders<T extends AnyContractRouter> {
  /** Default: requires a session; handlers get `context.session`. */
  procedure: ImplementerInternalWithMiddlewares<T, ApiContext, SessionApiContext>;
  /** Explicit opt-out, only for what anyone may call without logging in. */
  publicProcedure: Implementer<T, ApiContext, ApiContext>;
  /** Combines implemented procedures without adding middleware of its own. */
  router: RouterImplementer<T, ApiContext, ApiContext>['router'];
}

/**
 * Builders for implementing a contract (CLAUDE.md, authentication).
 * The return type is spelled out: inferred inside this generic function,
 * oRPC's conditional types would resolve against the constraint and lose
 * the procedure names.
 */
export function createBuilders<T extends AnyContractRouter>(
  contract: T,
  resolveSession: SessionResolver,
): Builders<T> {
  const base = implement(contract).$context<ApiContext>() as unknown as Implementer<
    T,
    ApiContext,
    ApiContext
  > &
    RouterImplementer<T, ApiContext, ApiContext>;

  const procedure = base.use(async ({ context, next }) => {
    const session = await resolveSession(context.headers);
    if (!session) throw new ORPCError('UNAUTHORIZED');
    return next({ context: { session } });
  });

  return {
    procedure: procedure as unknown as ImplementerInternalWithMiddlewares<
      T,
      ApiContext,
      SessionApiContext
    >,
    publicProcedure: base,
    router: base.router.bind(base),
  };
}
