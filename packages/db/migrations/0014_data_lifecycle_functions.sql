-- Tenant ids for jobs that run for every tenant, such as the retention sweep
-- (decision #038, docs/data-model.md §5). app_runtime cannot read across
-- tenants; this narrow function returns ids only, nothing else of the
-- organization. Runs as its owner (the migration role), with a fixed
-- search_path, and only app_runtime may execute it.
CREATE FUNCTION public.list_tenant_ids() RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT id FROM public.organization ORDER BY id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.list_tenant_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.list_tenant_ids() TO app_runtime;
