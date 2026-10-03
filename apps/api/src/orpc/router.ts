import { type ContractMeta, contract } from '@effectief/shared';
import { implement, ORPCError } from '@orpc/server';
import type { FastifyBaseLogger } from 'fastify';

export interface ApiContext {
  requestId: string;
  log: FastifyBaseLogger;
}

const os = implement(contract)
  .$context<ApiContext>()
  .use(async ({ procedure, next }) => {
    const { auth } = procedure['~orpc'].meta as ContractMeta;
    if (auth === 'public') return next();
    // No session system yet: anything that is not public is denied.
    throw new ORPCError('UNAUTHORIZED');
  });

export const router = os.router({
  system: {
    status: os.system.status.handler(() => ({ status: 'ok' as const })),
  },
});
