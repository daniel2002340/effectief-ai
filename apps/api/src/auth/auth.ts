import { and, asc, type Database, eq, schema, withTenant } from '@effectief/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { organization } from 'better-auth/plugins';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { type ApiEnv, isSignupAllowed } from '../env.ts';

export const AUTH_BASE_PATH = '/api/auth';

export interface AuthDependencies {
  env: Pick<ApiEnv, 'NODE_ENV' | 'APP_ORIGIN' | 'BETTER_AUTH_SECRET' | 'AUTH_SIGNUP_ALLOWLIST'>;
  /** Connection as auth_runtime: the auth tables only (decision #031). */
  authDb: Database;
  /** Connection as app_runtime, for tenant tables via withTenant(). */
  appDb: Database;
  log: FastifyBaseLogger;
}

/**
 * Better Auth (decision #030): email + password, organizations as tenants.
 * Rate limiting and logging are ours (Fastify plugins, pino with redaction),
 * so its own rate limiter and telemetry are off.
 */
export function createAuth({ env, authDb, appDb, log }: AuthDependencies) {
  return betterAuth({
    appName: 'EffectiefAI',
    baseURL: env.APP_ORIGIN,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_ORIGIN],
    database: drizzleAdapter(authDb, {
      provider: 'pg',
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        organization: schema.organization,
        member: schema.member,
        invitation: schema.invitation,
      },
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      autoSignIn: true,
    },
    advanced: {
      database: { generateId: 'uuid' },
      useSecureCookies: env.NODE_ENV === 'production',
      // Same origin only (decision #021); never sent on cross-site requests.
      defaultCookieAttributes: { sameSite: 'strict', httpOnly: true },
      // Explicit: Better Auth turns the origin check off when NODE_ENV is test,
      // which would make our CSRF tests pass without the real check.
      disableOriginCheck: false,
      disableCSRFCheck: false,
    },
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
    logger: {
      // Only the message: arguments can contain request data and personal data.
      log: (level, message) => log[level]({ source: 'better-auth' }, message),
    },
    databaseHooks: {
      user: {
        create: {
          // Every way a user comes into existence passes here, not only the
          // sign-up endpoint (decision #062). The message does not reveal
          // which addresses are allowed.
          before: async (user) => {
            if (!isSignupAllowed(env.AUTH_SIGNUP_ALLOWLIST, user.email)) {
              throw new APIError('FORBIDDEN', {
                message: 'Registreren is met dit e-mailadres nog niet mogelijk.',
              });
            }
          },
        },
      },
      session: {
        create: {
          // Start every session in a tenant: the user's oldest membership.
          before: async (session) => {
            if (session.activeOrganizationId) return;
            const [first] = await authDb
              .select({ organizationId: schema.member.organizationId })
              .from(schema.member)
              .where(eq(schema.member.userId, session.userId))
              .orderBy(asc(schema.member.createdAt))
              .limit(1);
            if (!first) return;
            return { data: { ...session, activeOrganizationId: first.organizationId } };
          },
        },
      },
    },
    plugins: [
      organization({
        creatorRole: 'owner',
        organizationHooks: {
          afterCreateOrganization: async ({ organization: created }) => {
            await withTenant(appDb, created.id, (tx) =>
              tx.insert(schema.tenantSettings).values({ tenantId: created.id }),
            );
          },
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** What the API knows about a logged-in request. */
export interface SessionContext {
  userId: string;
  /** From the session's active organization; never from request input. */
  tenantId: string;
  /** The user's role in that tenant. */
  role: z.infer<typeof membershipRoleSchema>;
}

const membershipRoleSchema = z.enum(['owner', 'admin', 'member']);

/**
 * Reads the session from the request's cookie. Returns null without a valid
 * session, without an active tenant, or when the user is no longer a member
 * of that tenant (or has a role we do not know).
 */
export async function resolveSession(
  auth: Auth,
  authDb: Database,
  headers: Headers,
): Promise<SessionContext | null> {
  const result = await auth.api.getSession({ headers });
  const tenantId = z.uuid().safeParse(result?.session.activeOrganizationId);
  if (!result || !tenantId.success) return null;

  const [membership] = await authDb
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(
      and(
        eq(schema.member.organizationId, tenantId.data),
        eq(schema.member.userId, result.user.id),
      ),
    )
    .limit(1);
  // An unknown role gets no session: deny by default.
  const role = membershipRoleSchema.safeParse(membership?.role);
  if (!role.success) return null;

  return { userId: result.user.id, tenantId: tenantId.data, role: role.data };
}
