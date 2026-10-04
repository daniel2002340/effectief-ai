ALTER TABLE "actions" DROP CONSTRAINT "actions_status";--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action";--> statement-breakpoint
ALTER TABLE "cards" DROP CONSTRAINT "cards_kind";--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "execution_job_id" text;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "action_id" uuid;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_action_fk" FOREIGN KEY ("tenant_id","action_id") REFERENCES "public"."actions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_last_error_code" CHECK ("actions"."last_error_code" in ('provider_unavailable', 'rate_limited', 'auth_expired', 'connection_inactive', 'rejected_by_provider', 'provider_object_missing', 'invalid_input', 'unsupported', 'unknown'));--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_executing_has_job" CHECK ("actions"."status" <> 'executing' or "actions"."execution_job_id" is not null);--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_status" CHECK ("actions"."status" in ('concept', 'approved', 'executing', 'executed', 'failed', 'rejected'));--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action" CHECK ("audit_log"."action" in ('connection.created', 'connection.reactivated', 'connection.revoked', 'connection.expired', 'connection.purged', 'card.created', 'card.reopened', 'card.snoozed', 'card.done', 'card.dismissed', 'card.expired', 'action.proposed', 'action.approved', 'action.started', 'action.rejected', 'action.executed', 'action.failed', 'action.reopened', 'fact.confirmed', 'fact.rejected', 'fact.superseded', 'playbook.confirmed', 'playbook.rejected', 'playbook.retired'));--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_action_failed" CHECK (("cards"."kind" = 'action_failed') = ("cards"."action_id" is not null));--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_kind" CHECK ("cards"."kind" in ('email_reply', 'quote_request', 'payment_overdue', 'connection_problem', 'knowledge_review', 'task_due', 'insight', 'action_failed'));