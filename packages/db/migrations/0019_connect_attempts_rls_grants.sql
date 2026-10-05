-- RLS, privileges and the tenant lookup for connect_attempts (decisions #075,
-- #081, docs/integrations.md §2.2). drizzle-kit generates neither FORCE ROW
-- LEVEL SECURITY, grants nor functions.
ALTER TABLE "connect_attempts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Deleted only by retention; the outcome is written once.
GRANT SELECT, INSERT, DELETE ON "connect_attempts" TO app_runtime;
--> statement-breakpoint
GRANT UPDATE ("consumed_at", "connection_id", "nango_connection_id", "failure_code") ON "connect_attempts" TO app_runtime;
--> statement-breakpoint
-- The tenant of a creation webhook: the connection does not exist yet, only
-- the nonce our server put on the connect session. Ids only, for any state of
-- the attempt; the job checks whether it is still open. Runs as its owner
-- (the migration role), with a fixed search_path, and only app_runtime may
-- execute it.
CREATE FUNCTION public.resolve_connect_attempt(p_nonce text)
RETURNS TABLE (tenant_id uuid, attempt_id uuid, provider text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT a.tenant_id, a.id, a.provider
    FROM public.connect_attempts a
   WHERE a.nonce = p_nonce
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.resolve_connect_attempt(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.resolve_connect_attempt(text) TO app_runtime;
