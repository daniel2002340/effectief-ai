import { contract } from '@effectief/shared';
import { createBuilders } from './builders.ts';

const { publicProcedure, router: buildRouter } = createBuilders(contract);

export const router = buildRouter({
  system: {
    status: publicProcedure.system.status.handler(() => ({ status: 'ok' as const })),
  },
});
