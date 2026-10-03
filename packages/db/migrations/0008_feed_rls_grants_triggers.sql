-- RLS, privileges and guards for feed and actions (docs/data-model.md §4 part A, §5).
-- drizzle-kit generates neither FORCE ROW LEVEL SECURITY, grants nor triggers.
ALTER TABLE "connections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "entity_external_refs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "cards" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "card_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "card_entities" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "actions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Connections are never deleted: the row stays as a tombstone after purging.
GRANT SELECT, INSERT ON "connections" TO app_runtime;
--> statement-breakpoint
GRANT UPDATE ("status", "status_reason", "status_changed_at", "last_synced_at", "account_label", "external_account_id", "updated_at") ON "connections" TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "cards" TO app_runtime;
--> statement-breakpoint
GRANT UPDATE ("status", "title", "summary", "payload", "priority", "snoozed_until", "resolved_at", "resolved_by_user_id", "updated_at") ON "cards" TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "card_events", "card_entities", "entity_external_refs" TO app_runtime;
--> statement-breakpoint
-- Actions are not deleted by the app (only by cascade from cards).
-- proposed_input may only be cleared by retention (actions_guard below).
GRANT SELECT, INSERT ON "actions" TO app_runtime;
--> statement-breakpoint
GRANT UPDATE ("status", "proposed_input", "input", "input_purged_at", "provider_object_id", "result", "approved_by_user_id", "approved_at", "executed_at", "attempts", "last_error_code", "updated_at") ON "actions" TO app_runtime;
--> statement-breakpoint
-- Append-only: no UPDATE or DELETE privilege, and policies for SELECT and INSERT only.
GRANT SELECT, INSERT ON "audit_log" TO app_runtime;
--> statement-breakpoint
-- Status transitions (decision #044). The allowed `from:to` pairs are the
-- trigger arguments; packages/shared/src/domain/transitions.ts has the same
-- lists and transitions.test.ts compares them.
CREATE FUNCTION public.status_transition_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT (OLD.status || ':' || NEW.status) = ANY (TG_ARGV) THEN
    RAISE EXCEPTION '%: status transition % -> % is not allowed (row %)',
      TG_TABLE_NAME, OLD.status, NEW.status, OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- New rows start in the first status; any other status is reached through
-- the transitions above, so an action can never be inserted as approved.
CREATE FUNCTION public.initial_status_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM TG_ARGV[0] THEN
    RAISE EXCEPTION '%: a new row must start as %, not %', TG_TABLE_NAME, TG_ARGV[0], NEW.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER connections_initial_status
  BEFORE INSERT ON "connections"
  FOR EACH ROW EXECUTE FUNCTION public.initial_status_guard('active');
--> statement-breakpoint
CREATE TRIGGER cards_initial_status
  BEFORE INSERT ON "cards"
  FOR EACH ROW EXECUTE FUNCTION public.initial_status_guard('open');
--> statement-breakpoint
CREATE TRIGGER actions_initial_status
  BEFORE INSERT ON "actions"
  FOR EACH ROW EXECUTE FUNCTION public.initial_status_guard('concept');
--> statement-breakpoint
CREATE TRIGGER connections_status_guard
  BEFORE UPDATE OF "status" ON "connections"
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.status_transition_guard(
    'active:revoked', 'active:expired',
    'expired:active', 'expired:revoked', 'expired:purged',
    'revoked:purged'
  );
--> statement-breakpoint
CREATE TRIGGER cards_status_guard
  BEFORE UPDATE OF "status" ON "cards"
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.status_transition_guard(
    'open:snoozed', 'open:done', 'open:dismissed', 'open:expired',
    'snoozed:open', 'snoozed:done', 'snoozed:dismissed', 'snoozed:expired'
  );
--> statement-breakpoint
CREATE TRIGGER actions_status_guard
  BEFORE UPDATE OF "status" ON "actions"
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.status_transition_guard(
    'concept:approved', 'concept:rejected',
    'approved:executed', 'approved:failed',
    'failed:approved',
    'executed:concept'
  );
--> statement-breakpoint
-- What "never send without approval" and "a repeat updates the same object"
-- depend on, enforced for every role:
-- * a new action carries no approval, execution or provider object;
-- * input only changes while the action is a concept;
-- * proposed_input never changes;
-- * provider_object_id never changes once set.
-- Retention may clear both inputs together with input_purged_at.
CREATE FUNCTION public.actions_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  purging boolean := NEW.input_purged_at IS NOT NULL
    AND NEW.proposed_input IS NULL AND NEW.input IS NULL;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.approved_by_user_id IS NOT NULL OR NEW.approved_at IS NOT NULL
       OR NEW.executed_at IS NOT NULL OR NEW.provider_object_id IS NOT NULL
       OR NEW.result IS NOT NULL OR NEW.input_purged_at IS NOT NULL
       OR NEW.input IS DISTINCT FROM NEW.proposed_input THEN
      RAISE EXCEPTION 'actions: a new action is an unapproved, unexecuted proposal'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.proposed_input IS DISTINCT FROM OLD.proposed_input AND NOT purging THEN
    RAISE EXCEPTION 'actions.proposed_input cannot be changed (action %)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.input IS DISTINCT FROM OLD.input AND OLD.status <> 'concept' AND NOT purging THEN
    RAISE EXCEPTION 'actions.input can only be changed in concept (action %)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.provider_object_id IS NOT NULL
     AND NEW.provider_object_id IS DISTINCT FROM OLD.provider_object_id THEN
    RAISE EXCEPTION 'actions.provider_object_id cannot be changed once set (action %)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER actions_guard
  BEFORE INSERT OR UPDATE ON "actions"
  FOR EACH ROW EXECUTE FUNCTION public.actions_guard();
--> statement-breakpoint
-- audit_log is append-only, also for the owner. The one exception is the
-- cascade from deleting the organization (cancelling the tenant): that
-- DELETE runs inside the foreign-key trigger, so pg_trigger_depth() > 1.
-- A direct DELETE runs at depth 1 (decision #045).
CREATE FUNCTION public.audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only (%)', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_log_append_only();
