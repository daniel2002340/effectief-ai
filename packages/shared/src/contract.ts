import { oc } from '@orpc/contract';
import { z } from 'zod';
import { vatRateBpsSchema } from './domain/money.ts';

// The contract describes shapes only. Who may call a procedure is decided in
// the API: procedures require a session unless implemented as publicProcedure.

export const systemStatusOutputSchema = z.object({
  status: z.literal('ok'),
});

export const currentTenantSchema = z.object({
  name: z.string(),
  defaultVatRateBps: vatRateBpsSchema,
});
export type CurrentTenant = z.infer<typeof currentTenantSchema>;

export const updateTenantSettingsInputSchema = z.object({
  defaultVatRateBps: vatRateBpsSchema,
});

export const contract = {
  system: {
    status: oc.route({ method: 'GET', path: '/system/status' }).output(systemStatusOutputSchema),
  },
  tenant: {
    /** The tenant of the session: its name and settings. */
    current: oc.route({ method: 'GET', path: '/tenant' }).output(currentTenantSchema),
    updateSettings: oc
      .route({ method: 'POST', path: '/tenant/settings' })
      .input(updateTenantSettingsInputSchema)
      .output(currentTenantSchema),
  },
};

export type Contract = typeof contract;
