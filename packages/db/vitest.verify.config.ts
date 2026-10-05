import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.ts';

// The tests that prove the runtime roles are bound by RLS and that tenants
// cannot see each other's rows. They connect only as the app role and the
// auth role, never as the owner, so they can run against a deployed database
// from the verify job (decision #065). They create their own test tenants and
// delete them afterwards.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      // Against a deployed database every query crosses the network; the
      // seeding hooks run hundreds of them.
      hookTimeout: 120_000,
      testTimeout: 30_000,
      include: [
        'src/roles.test.ts',
        'src/with-tenant.test.ts',
        'src/feed/isolation.test.ts',
        'src/memory/isolation.test.ts',
        'src/memory/grants.test.ts',
        'src/knowledge/isolation.test.ts',
      ],
    },
  }),
);
