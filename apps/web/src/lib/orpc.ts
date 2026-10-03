import { type Contract, contract } from '@effectief/shared';
import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import { env } from './env.ts';

const link = new OpenAPILink(contract, {
  url: () => `${window.location.origin}${env.VITE_API_BASE_PATH}`,
});

const client: ContractRouterClient<Contract> = createORPCClient(link);

/** Typed TanStack Query helpers for every procedure in the contract. */
export const orpc = createTanstackQueryUtils(client);
