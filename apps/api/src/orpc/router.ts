import { type Database, eq, schema, withTenant } from '@effectief/db';
import { type CurrentTenant, contract, currentTenantSchema } from '@effectief/shared';
import { ORPCError } from '@orpc/server';
import { actionHandlers, type EnqueueExecuteAction } from './actions.ts';
import { createBuilders, type SessionResolver } from './builders.ts';
import { cardHandlers } from './cards.ts';
import { entityHandlers } from './entities.ts';
import { createTestRouter, type EnqueueMonitoringTest } from './test-errors.ts';

export interface RouterDependencies {
  /** Connection as app_runtime; customer data only via withTenant(). */
  appDb: Database;
  resolveSession: SessionResolver;
  enqueueExecuteAction: EnqueueExecuteAction;
  /** Only outside production; without it the test procedures do not exist (decision #069). */
  enqueueMonitoringTest: EnqueueMonitoringTest | undefined;
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

export function createRouter({
  appDb,
  resolveSession,
  enqueueExecuteAction,
  enqueueMonitoringTest,
}: RouterDependencies) {
  const { procedure, publicProcedure, router } = createBuilders(contract, resolveSession);
  const actions = actionHandlers({ appDb, enqueueExecuteAction });
  const cards = cardHandlers({ appDb });
  const entities = entityHandlers({ appDb });

  const main = router({
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
    actions: {
      approve: procedure.actions.approve.handler(({ context, input }) =>
        actions.approve(context, input),
      ),
      reject: procedure.actions.reject.handler(({ context, input }) =>
        actions.reject(context, input),
      ),
    },
    cards: {
      list: procedure.cards.list.handler(({ context, input }) => cards.list(context, input)),
      get: procedure.cards.get.handler(({ context, input }) => cards.get(context, input)),
    },
    entities: {
      get: procedure.entities.get.handler(({ context, input }) => entities.get(context, input)),
    },
  });
  if (!enqueueMonitoringTest) return main;
  return { ...main, ...createTestRouter(resolveSession, enqueueMonitoringTest) };
}

export type ApiRouter = ReturnType<typeof createRouter>;
