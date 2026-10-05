// Railway project as code (decisions #061, #064). Applied by the deploy
// workflow with `railway config apply`; IMAGE_TAG is the git SHA whose images
// it just built. Secrets are not in here: they are shared variables or
// `preserve()`, so their values stay in Railway. What this DSL cannot express
// (TCP proxy off, PITR, volume backups, registry credentials) is a manual
// step in docs/todo.md. Nothing in apps/ or packages/ knows about Railway.
import { database, defineRailway, image, preserve, project, redis, service } from 'railway/iac';

/** EU West (Amsterdam). */
const region = 'europe-west4-drams3a';
const registry = 'ghcr.io/daniel2002340';

/** A Railway reference such as `${{postgres.PGDATABASE}}`, resolved by Railway at runtime. */
const railwayVar = (path: string) => `\${{${path}}}`;

export default defineRailway((ctx) => {
  const tag = process.env.IMAGE_TAG ?? '';
  if (!/^[0-9a-f]{40}$/.test(tag)) throw new Error('IMAGE_TAG must be a full git SHA');
  const production = ctx.isEnvironment('production');
  const origin = production ? 'app.effectiefai.nl' : 'staging.effectiefai.nl';
  const app = (name: string) => image(`${registry}/effectief-${name}:${tag}`);
  const one = { [region]: 1 };

  // Railway's Postgres image on major 17 (not the DSL's default 18). It ships
  // pgvector and pgBackRest for point-in-time recovery (#063).
  const postgres = database('postgres', 'postgres', {
    image: 'ghcr.io/railwayapp-templates/postgres-ssl:17',
    output: 'DATABASE_URL',
    defaultMountPath: '/var/lib/postgresql/data',
    region,
  });
  // Railway's Redis: password and private URL included; noeviction by default,
  // which BullMQ needs.
  const queue = redis('redis', { region });

  // Runtime connections as the login roles the migration job creates (#059);
  // never the owner. Passwords are shared variables, so api, worker and migrate
  // agree without anyone copying them.
  const runtimeUrl = (role: string, password: string) =>
    `postgresql://${role}:${railwayVar(`shared.${password}`)}@${railwayVar('postgres.RAILWAY_PRIVATE_DOMAIN')}:5432/${railwayVar('postgres.PGDATABASE')}`;
  const databaseUrl = runtimeUrl('effectief_app', 'APP_DB_PASSWORD');
  const databaseAuthUrl = runtimeUrl('effectief_auth', 'AUTH_DB_PASSWORD');
  const common = { NODE_ENV: 'production', LOG_LEVEL: 'info' };
  const monitoring = {
    SENTRY_DSN: preserve(),
    SENTRY_ENVIRONMENT: production ? 'production' : 'staging',
  };

  // The only service with the owner's credentials. Its pre-deploy migrates;
  // its start command reports and exits (#058).
  const migrate = service('migrate', {
    source: app('migrate'),
    preDeploy: 'node dist/main.js',
    replicas: one,
    deploy: { restartPolicyType: 'NEVER' },
    env: {
      ...common,
      DATABASE_MIGRATION_URL: postgres.env.DATABASE_URL,
      DATABASE_URL: databaseUrl,
      DATABASE_AUTH_URL: databaseAuthUrl,
    },
  });

  // Pre-deploy waits until the schema has this build's migration (#064).
  const api = service('api', {
    source: app('api'),
    preDeploy: 'node dist/check-schema.js',
    healthcheck: '/health',
    replicas: one,
    env: {
      ...common,
      ...monitoring,
      API_HOST: '::',
      API_PORT: '3000',
      PORT: '3000',
      // Caddy is the only hop and sets X-Forwarded-For itself (#057).
      API_TRUST_PROXY: '1',
      APP_ORIGIN: `https://${origin}`,
      DATABASE_URL: databaseUrl,
      DATABASE_AUTH_URL: databaseAuthUrl,
      REDIS_URL: queue.env.REDIS_URL,
      BETTER_AUTH_SECRET: preserve(),
      AUTH_SIGNUP_ALLOWLIST: preserve(),
    },
  });

  const worker = service('worker', {
    source: app('worker'),
    preDeploy: 'node dist/check-schema.js',
    replicas: one,
    deploy: { drainingSeconds: 30 },
    env: {
      ...common,
      ...monitoring,
      DATABASE_URL: databaseUrl,
      REDIS_URL: queue.env.REDIS_URL,
    },
  });

  // The only public service (#057). Pre-deploy waits for the api of the same release.
  // No `domains` yet: Railway's IaC cannot register a custom domain. It is
  // added to this service in the dashboard (port 8080) once the service
  // exists, and then declared here (decision #066, docs/todo.md).
  const edge = service('edge', {
    source: app('edge'),
    preDeploy: 'edge-wait-for-api',
    healthcheck: '/health',
    replicas: one,
    env: {
      PORT: '8080',
      API_UPSTREAM: `${railwayVar('api.RAILWAY_PRIVATE_DOMAIN')}:3000`,
    },
  });

  // The RLS and role tests of packages/db against this database, on every
  // deploy, as the app and auth roles only (decision #065). Not in production:
  // the tests write (and delete) tenants of their own. Result in its deploy log.
  const verify = service('verify', {
    source: app('verify'),
    preDeploy: 'node scripts/wait-for-schema.ts',
    replicas: one,
    deploy: { restartPolicyType: 'NEVER' },
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      DATABASE_AUTH_URL: databaseAuthUrl,
    },
  });

  return project('effectiefai', {
    // Both exist in Railway; listing them keeps an apply from touching either one's existence.
    environments: ['staging', 'production'],
    resources: [postgres, queue, migrate, api, worker, edge, ...(production ? [] : [verify])],
  });
});
