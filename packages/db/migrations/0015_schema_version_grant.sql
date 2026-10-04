-- api and worker check before they start that the schema is at least the
-- version they were built for (decision #058). They read the migration
-- table as app_runtime: no write access, nothing else in the schema.
GRANT USAGE ON SCHEMA drizzle TO app_runtime;
--> statement-breakpoint
GRANT SELECT ON drizzle.__drizzle_migrations TO app_runtime;
