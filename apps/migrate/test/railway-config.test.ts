import { createRailwayContext, project } from 'railway/iac';
import { afterEach, describe, expect, it } from 'vitest';

// Guards the deploy design in .railway/railway.ts (decisions #057, #058, #064).
// Runs the IaC program like the Railway CLI does, without an account.

const tag = 'a'.repeat(40);
type Resource = {
  name: string;
  type: string;
  source?: { image?: string };
  deploy?: { preDeployCommand?: string[]; restartPolicyType?: string };
  networking?: { customDomains?: Record<string, unknown>; tcpProxies?: unknown };
  variables?: Record<string, { type: string; value?: string; resource?: string; output?: string }>;
};

async function render(environment: string, imageTag: string | null = tag) {
  if (imageTag === null) delete process.env.IMAGE_TAG;
  else process.env.IMAGE_TAG = imageTag;
  const { default: program } = await import('../../../.railway/railway.ts');
  const definition = await program(createRailwayContext({ environment }), project);
  const resources = definition.resources as unknown as Resource[];
  const byName = (name: string) => {
    const resource = resources.find((r) => r.name === name);
    if (!resource) throw new Error(`no resource ${name}`);
    return resource;
  };
  return { resources, byName };
}

afterEach(() => {
  delete process.env.IMAGE_TAG;
});

/** Does a variable give access to the owner's credentials? */
function exposesOwner(variable: NonNullable<Resource['variables']>[string]): boolean {
  if (variable.type === 'reference') {
    return (
      variable.resource === 'database.postgres' &&
      [
        'DATABASE_URL',
        'DATABASE_PUBLIC_URL',
        'PGPASSWORD',
        'PGUSER',
        'POSTGRES_PASSWORD',
        'POSTGRES_USER',
      ].includes(variable.output ?? '')
    );
  }
  return /\$\{\{\s*postgres\.(DATABASE_URL|DATABASE_PUBLIC_URL|PGPASSWORD|PGUSER|POSTGRES_PASSWORD|POSTGRES_USER)\s*\}\}/.test(
    variable.value ?? '',
  );
}

describe('.railway/railway.ts', () => {
  it('gives the owner credentials to the migration job only', async () => {
    const { resources } = await render('staging');
    const exposed = resources
      .filter((r) => r.type === 'service')
      .flatMap((r) =>
        Object.entries(r.variables ?? {})
          .filter(([key, variable]) => key === 'DATABASE_MIGRATION_URL' || exposesOwner(variable))
          .map(([key]) => `${r.name}.${key}`),
      );
    expect(exposed).toEqual(['migrate.DATABASE_MIGRATION_URL']);
  });

  it('connects api and worker as the runtime login roles', async () => {
    const { byName } = await render('staging');
    for (const name of ['api', 'worker']) {
      expect(byName(name).variables?.DATABASE_URL?.value).toMatch(/^postgresql:\/\/effectief_app:/);
    }
    expect(byName('api').variables?.DATABASE_AUTH_URL?.value).toMatch(
      /^postgresql:\/\/effectief_auth:/,
    );
    expect(byName('worker').variables?.DATABASE_AUTH_URL).toBeUndefined();
  });

  it('exposes no service publicly from the file, with no TCP proxies anywhere', async () => {
    // The edge's domain is added in the dashboard first (decision #066).
    const { resources } = await render('staging');
    const publicServices = resources.filter(
      (r) => Object.keys(r.networking?.customDomains ?? {}).length > 0,
    );
    expect(publicServices.map((r) => r.name)).toEqual([]);
    expect(resources.filter((r) => r.networking?.tcpProxies)).toEqual([]);
  });

  it('deploys every app from the same commit and enforces the order in pre-deploys', async () => {
    const { byName } = await render('staging');
    for (const name of ['migrate', 'api', 'worker', 'edge']) {
      expect(byName(name).source?.image).toBe(`ghcr.io/daniel2002340/effectief-${name}:${tag}`);
    }
    expect(byName('migrate').deploy).toMatchObject({
      preDeployCommand: ['node dist/main.js'],
      restartPolicyType: 'NEVER',
    });
    expect(byName('api').deploy?.preDeployCommand).toEqual(['node dist/check-schema.js']);
    expect(byName('worker').deploy?.preDeployCommand).toEqual(['node dist/check-schema.js']);
    expect(byName('edge').deploy?.preDeployCommand).toEqual(['edge-wait-for-api']);
  });

  it('runs the RLS and role tests on staging as the runtime roles, not in production', async () => {
    const { byName } = await render('staging');
    const verify = byName('verify');
    expect(verify.source?.image).toBe(`ghcr.io/daniel2002340/effectief-verify:${tag}`);
    expect(verify.deploy).toMatchObject({
      preDeployCommand: ['node scripts/wait-for-schema.ts'],
      restartPolicyType: 'NEVER',
    });
    expect(verify.variables?.DATABASE_URL?.value).toMatch(/^postgresql:\/\/effectief_app:/);
    expect(verify.variables?.DATABASE_AUTH_URL?.value).toMatch(/^postgresql:\/\/effectief_auth:/);
    const { resources } = await render('production');
    expect(resources.map((r) => r.name)).not.toContain('verify');
  });

  it('keeps secrets out of the file', async () => {
    const { byName } = await render('staging');
    for (const key of ['BETTER_AUTH_SECRET', 'AUTH_SIGNUP_ALLOWLIST', 'SENTRY_DSN']) {
      expect(byName('api').variables?.[key]).toEqual({ type: 'preserve' });
    }
  });

  it('uses Postgres 17, like CI and local development', async () => {
    const { byName } = await render('staging');
    expect(byName('postgres').source?.image).toBe('ghcr.io/railwayapp-templates/postgres-ssl:17');
  });

  it('serves production on its own domain', async () => {
    const { byName } = await render('production');
    expect(byName('api').variables?.APP_ORIGIN?.value).toBe('https://app.effectiefai.nl');
    expect(byName('api').variables?.SENTRY_ENVIRONMENT?.value).toBe('production');
  });

  it('refuses to render without a full git SHA as image tag', async () => {
    await expect(render('staging', null)).rejects.toThrow(/IMAGE_TAG/);
    await expect(render('staging', 'latest')).rejects.toThrow(/IMAGE_TAG/);
  });
});
