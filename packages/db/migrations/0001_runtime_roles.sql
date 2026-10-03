-- Group roles for runtime connections (decisions #026, #031). NOLOGIN: login
-- roles with passwords are created outside migrations and made members.
-- Neither role may bypass RLS or own tables; the migration owner owns everything.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'auth_runtime') THEN
    CREATE ROLE auth_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_runtime, auth_runtime;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
