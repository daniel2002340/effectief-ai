import { oc } from '@orpc/contract';
import { z } from 'zod';
import type { ContractAuthType } from './auth.ts';

export interface ContractMeta {
  /** Required on every procedure; checked when the API starts. */
  auth?: ContractAuthType;
}

const base = oc.$meta<ContractMeta>({});

export const systemStatusOutputSchema = z.object({
  status: z.literal('ok'),
});

export const contract = {
  system: {
    status: base
      .meta({ auth: 'public' })
      .route({ method: 'GET', path: '/system/status' })
      .output(systemStatusOutputSchema),
  },
};

export type Contract = typeof contract;
