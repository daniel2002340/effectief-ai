import { sql } from 'drizzle-orm';
import { pgRole } from 'drizzle-orm/pg-core';

// Group roles (NOLOGIN), created in migration 0001. Login roles are members
// of exactly one of them; they are created outside migrations because they
// carry passwords (see scripts/create-login-roles.ts for dev and CI).

/** Runtime role for routes and jobs: no BYPASSRLS, owns nothing (decision #026). */
export const appRuntime = pgRole('app_runtime').existing();

/** Better Auth's role: the auth tables only, across tenants (decision #031). */
export const authRuntime = pgRole('auth_runtime').existing();

/**
 * The tenant set by withTenant() for the current transaction, or NULL when
 * there is none. A policy comparing against NULL matches no rows, so a query
 * without tenant context returns nothing and writes are rejected.
 */
export const currentTenantId = sql`nullif(current_setting('app.tenant_id', true), '')::uuid`;
