import { type Contract, contract, type TestContract, testContract } from '@effectief/shared';
import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import { env } from './env.ts';

const url = () => `${window.location.origin}${env.VITE_API_BASE_PATH}`;
const link = new OpenAPILink(contract, { url });

const client: ContractRouterClient<Contract> = createORPCClient(link);

/** Typed TanStack Query helpers for every procedure in the contract. */
export const orpc = createTanstackQueryUtils(client);

/** The test procedures (decision #069); the API only has them outside production. */
export const testClient: ContractRouterClient<TestContract> = createORPCClient(
  new OpenAPILink(testContract, { url }),
);
