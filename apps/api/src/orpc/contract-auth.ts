import { type ContractMeta, contractAuthTypeSchema } from '@effectief/shared';
import { isContractProcedure } from '@orpc/contract';

/**
 * Throws unless every procedure in the contract declares a valid `meta.auth`.
 * Runs at startup, so a procedure without auth means the API does not start.
 */
export function assertContractAuth(router: unknown, path: string[] = []): void {
  if (isContractProcedure(router)) {
    const meta = router['~orpc'].meta as ContractMeta;
    if (!contractAuthTypeSchema.safeParse(meta.auth).success) {
      throw new Error(`Contract procedure ${path.join('.')}: missing or unknown meta.auth`);
    }
    return;
  }
  if (typeof router !== 'object' || router === null) {
    throw new Error(`Contract entry ${path.join('.')} is not a procedure or router`);
  }
  for (const [key, child] of Object.entries(router)) {
    assertContractAuth(child, [...path, key]);
  }
}
