import { type Database, eq, schema, withTenant } from '@effectief/db';
import { type CurrentTenant, contract, currentTenantSchema } from '@effectief/shared';
import { ORPCError } from '@orpc/server';
import { createBuilders, type SessionResolver } from './builders.ts';

export interface RouterDependencies {
  /** Connection as app_runtime; customer data only via withTenant(). */
  appDb: Database;
  resolveSession: SessionResolver;
}

/** Reads the tenant within its RLS scope: organization and settings of `tenantId` only. */
async function readCurrentTenant(appDb: Database, tenantId: string): Promise<CurrentTenant> {
  const [row] = await withTenant(appDb, tenantId, (tx) =>
    tx
      .select({
        name: schema.organization.name,
        defaultVatRateBps: schema.tenantSettings.defaultVatRateBps,
      })
      .from(schema.tenantSettings)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.tenantSettings.tenantId)),
  );
  if (!row) throw new ORPCError('NOT_FOUND');
  return currentTenantSchema.parse(row);
}

export function createRouter({ appDb, resolveSession }: RouterDependencies) {
  const { procedure, publicProcedure, router } = createBuilders(contract, resolveSession);

  return router({
    system: {
      status: publicProcedure.system.status.handler(() => ({ status: 'ok' as const })),
    },
    tenant: {
      current: procedure.tenant.current.handler(({ context }) =>
        readCurrentTenant(appDb, context.session.tenantId),
      ),
      updateSettings: procedure.tenant.updateSettings.handler(async ({ context, input }) => {
        const { tenantId } = context.session;
        await withTenant(appDb, tenantId, (tx) =>
          tx
            .update(schema.tenantSettings)
            .set({ defaultVatRateBps: input.defaultVatRateBps })
            .where(eq(schema.tenantSettings.tenantId, tenantId)),
        );
        return readCurrentTenant(appDb, tenantId);
      }),
    },
  });
}

export type ApiRouter = ReturnType<typeof createRouter>;
