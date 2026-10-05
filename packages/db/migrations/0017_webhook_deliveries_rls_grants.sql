-- RLS, privileges and the tenant lookup for webhook_deliveries (decision #038,
-- docs/data-model.md §5). drizzle-kit generates neither FORCE ROW LEVEL
-- SECURITY, grants nor functions.
ALTER TABLE "webhook_deliveries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "webhook_deliveries" TO app_runtime;
--> statement-breakpoint
GRANT UPDATE ("status", "attempts", "last_error_code", "processed_at") ON "webhook_deliveries" TO app_runtime;
--> statement-breakpoint
-- The tenant of a webhook. The webhook only knows the Nango integration and
-- connection; app_runtime cannot search across tenants. This narrow function
-- returns ids only, for any status: a revoked or purged connection is a
-- tombstone that late webhooks still find, so the job can ignore them. Runs as
-- its owner (the migration role), with a fixed search_path, and only
-- app_runtime may execute it.
CREATE FUNCTION public.resolve_connection(p_integration_id text, p_connection_id text)
RETURNS TABLE (tenant_id uuid, connection_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT c.tenant_id, c.id
    FROM public.connections c
   WHERE c.nango_integration_id = p_integration_id
     AND c.nango_connection_id = p_connection_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.resolve_connection(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.resolve_connection(text, text) TO app_runtime;
