-- Executing actions (decision #050): the status `executing`, owned by one job,
-- and edits after executing only for types whose provider object can be
-- updated. packages/shared has the same lists; transitions.test.ts and
-- execution.test.ts compare them with the trigger arguments.
GRANT UPDATE ("execution_job_id") ON "actions" TO app_runtime;
--> statement-breakpoint
DROP TRIGGER actions_status_guard ON "actions";
--> statement-breakpoint
CREATE TRIGGER actions_status_guard
  BEFORE UPDATE OF "status" ON "actions"
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.status_transition_guard(
    'concept:approved', 'concept:rejected',
    'approved:executing',
    'executing:executed', 'executing:failed',
    'failed:approved', 'failed:concept',
    'executed:concept'
  );
--> statement-breakpoint
-- A final type (a sent mail) cannot go back from executed to concept: executing
-- it again would send a second mail instead of updating one object.
CREATE FUNCTION public.actions_final_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.status = 'executed' AND NEW.status = 'concept' AND OLD.type = ANY (TG_ARGV) THEN
    RAISE EXCEPTION 'actions: % cannot be edited after executing (action %)', OLD.type, OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER actions_final_guard
  BEFORE UPDATE OF "status" ON "actions"
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.actions_final_guard('email.reply', 'moneybird.invoice_reminder');
