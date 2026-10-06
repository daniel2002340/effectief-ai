-- RLS and privileges for sync_cursors (decision #076, docs/integrations.md
-- §4.2). drizzle-kit generates neither FORCE ROW LEVEL SECURITY nor grants.
ALTER TABLE "sync_cursors" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Removed with its connection (cascade); the ingest only moves the cursor.
GRANT SELECT, INSERT ON "sync_cursors" TO app_runtime;
--> statement-breakpoint
GRANT UPDATE ("cursor", "updated_at") ON "sync_cursors" TO app_runtime;
