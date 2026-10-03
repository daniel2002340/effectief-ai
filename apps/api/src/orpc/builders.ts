import type { AnyContractRouter } from '@orpc/contract';
import {
  type Implementer,
  type ImplementerInternalWithMiddlewares,
  implement,
  ORPCError,
  type RouterImplementer,
} from '@orpc/server';
import type { FastifyBaseLogger } from 'fastify';

export interface ApiContext {
  requestId: string;
  log: FastifyBaseLogger;
}

export interface Builders<T extends AnyContractRouter> {
  /** Default: requires a session. */
  procedure: ImplementerInternalWithMiddlewares<T, ApiContext, ApiContext>;
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
export function createBuilders<T extends AnyContractRouter>(contract: T): Builders<T> {
  const base = implement(contract).$context<ApiContext>() as unknown as Implementer<
    T,
    ApiContext,
    ApiContext
  > &
    RouterImplementer<T, ApiContext, ApiContext>;

  const procedure = base.use(async () => {
    // No session system yet: nothing can authenticate, so everything is denied.
    throw new ORPCError('UNAUTHORIZED');
  });

  return {
    procedure: procedure as ImplementerInternalWithMiddlewares<T, ApiContext, ApiContext>,
    publicProcedure: base,
    router: base.router.bind(base),
  };
}
