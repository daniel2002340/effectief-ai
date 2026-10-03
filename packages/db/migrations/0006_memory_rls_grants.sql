-- RLS and privileges for the company memory (docs/data-model.md §5).
-- drizzle-kit generates neither FORCE ROW LEVEL SECURITY nor grants.
ALTER TABLE "entities" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "entity_identifiers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "relations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "event_contents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "event_entities" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tasks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "task_entities" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Mutable tables: UPDATE only on the columns listed in §5 (plus updated_at).
GRANT SELECT, INSERT, DELETE ON "entities" TO app_runtime;
--> statement-breakpoint
GRANT UPDATE ("name", "attributes", "archived_at", "merged_into_id", "updated_at") ON "entities" TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "tasks" TO app_runtime;
--> statement-breakpoint
GRANT UPDATE ("title", "notes", "due_at", "status", "assignee_user_id", "completed_at", "completed_by_user_id", "updated_at") ON "tasks" TO app_runtime;
--> statement-breakpoint
-- Relations: content is immutable; ending one is valid_to, never DELETE.
GRANT SELECT, INSERT ON "relations" TO app_runtime;
--> statement-breakpoint
GRANT UPDATE ("status", "valid_to", "confirmed_by_user_id", "confirmed_at", "updated_at") ON "relations" TO app_runtime;
--> statement-breakpoint
-- Timeline: append-only. Only the summary can be added later, once (trigger below).
-- DELETE is for forgetEntity and disconnecting a connection.
GRANT SELECT, INSERT, DELETE ON "events" TO app_runtime;
--> statement-breakpoint
GRANT UPDATE ("summary", "summarized_at") ON "events" TO app_runtime;
--> statement-breakpoint
-- Immutable: source content is inserted, then deleted by retention or forget.
GRANT SELECT, INSERT, DELETE ON "event_contents", "entity_identifiers", "event_entities", "task_entities" TO app_runtime;
--> statement-breakpoint
CREATE FUNCTION public.events_summary_once() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.summary IS NOT NULL
     AND (NEW.summary IS DISTINCT FROM OLD.summary OR NEW.summarized_at IS DISTINCT FROM OLD.summarized_at) THEN
    RAISE EXCEPTION 'events.summary can only be set once (event %)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER events_summary_once
  BEFORE UPDATE ON "events"
  FOR EACH ROW EXECUTE FUNCTION public.events_summary_once();
