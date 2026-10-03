import { oc } from '@orpc/contract';
import { z } from 'zod';

// The contract describes shapes only. Who may call a procedure is decided in
// the API: procedures require a session unless implemented as publicProcedure.

export const systemStatusOutputSchema = z.object({
  status: z.literal('ok'),
});

/** VAT rates in basis points (2100 = 21%). */
export const vatRateBpsSchema = z.union([z.literal(0), z.literal(900), z.literal(2100)]);

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
