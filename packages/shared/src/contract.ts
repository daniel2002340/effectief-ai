import { oc } from '@orpc/contract';
import { z } from 'zod';
import { vatRateBpsSchema } from './domain/money.ts';
import { actionErrorCodes, actionStatuses, actionTypes } from './domain/status.ts';

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

/** What the UI gets back about an action; no input, which can hold personal data. */
export const actionSummarySchema = z.object({
  id: z.uuid(),
  cardId: z.uuid(),
  type: z.enum(actionTypes),
  status: z.enum(actionStatuses),
  approvedAt: z.date().nullable(),
  executedAt: z.date().nullable(),
  lastErrorCode: z.enum(actionErrorCodes).nullable(),
});
export type ActionSummary = z.infer<typeof actionSummarySchema>;

/**
 * Approve a concept (optionally with the edited input) or retry a failed
 * action. The input is checked against the schema of the action's type.
 */
export const approveActionInputSchema = z.object({
  actionId: z.uuid(),
  input: z.record(z.string(), z.unknown()).optional(),
});

export const rejectActionInputSchema = z.object({
  actionId: z.uuid(),
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
  actions: {
    /** Approves; executing follows in the worker. */
    approve: oc
      .route({ method: 'POST', path: '/actions/approve' })
      .input(approveActionInputSchema)
      .output(actionSummarySchema),
    reject: oc
      .route({ method: 'POST', path: '/actions/reject' })
      .input(rejectActionInputSchema)
      .output(actionSummarySchema),
  },
};

export type Contract = typeof contract;
