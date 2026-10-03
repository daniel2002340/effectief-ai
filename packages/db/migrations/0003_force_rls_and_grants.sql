-- FORCE: RLS also applies to the table owner, so nothing but a superuser or a
-- BYPASSRLS role skips the policies. drizzle-kit does not generate this.
ALTER TABLE "organization" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "member" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_settings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Better Auth: the auth tables only (decision #031).
GRANT SELECT, INSERT, UPDATE, DELETE
  ON "user", "session", "account", "verification", "organization", "member", "invitation"
  TO auth_runtime;
--> statement-breakpoint
-- App: its own tenant's organization and members (read-only, via RLS), and
-- the tenant tables. No access to users, sessions, accounts or tokens.
GRANT SELECT ON "organization", "member" TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_settings" TO app_runtime;
