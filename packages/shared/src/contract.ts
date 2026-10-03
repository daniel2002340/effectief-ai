import { oc } from '@orpc/contract';
import { z } from 'zod';

// The contract describes shapes only. Who may call a procedure is decided in
// the API: procedures require a session unless implemented as publicProcedure.

export const systemStatusOutputSchema = z.object({
  status: z.literal('ok'),
});

export const contract = {
  system: {
    status: oc.route({ method: 'GET', path: '/system/status' }).output(systemStatusOutputSchema),
  },
};

export type Contract = typeof contract;
