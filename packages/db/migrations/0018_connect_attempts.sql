CREATE TABLE "connect_attempts" (
	"id" uuid PRIMARY KEY DEFAULT public.gen_uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"nonce" text NOT NULL,
	"provider" text NOT NULL,
	"nango_integration_id" text NOT NULL,
	"created_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"connection_id" uuid,
	"nango_connection_id" text,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connect_attempts_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "connect_attempts_nonce_unique" UNIQUE("nonce"),
	CONSTRAINT "connect_attempts_nonce" CHECK ("connect_attempts"."nonce" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "connect_attempts_provider" CHECK ("connect_attempts"."provider" in ('gmail', 'outlook', 'moneybird', 'mollie')),
	CONSTRAINT "connect_attempts_failure_code" CHECK ("connect_attempts"."failure_code" in ('duplicate_account', 'rejected', 'expired')),
	CONSTRAINT "connect_attempts_outcome" CHECK (("connect_attempts"."consumed_at" is null) = ("connect_attempts"."connection_id" is null and "connect_attempts"."failure_code" is null)),
	CONSTRAINT "connect_attempts_single_outcome" CHECK ("connect_attempts"."connection_id" is null or "connect_attempts"."failure_code" is null)
);
--> statement-breakpoint
ALTER TABLE "connect_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action";--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_object_type";--> statement-breakpoint
ALTER TABLE "connections" DROP CONSTRAINT "connections_status_reason";--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "connection_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "connect_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "connect_attempts" ADD CONSTRAINT "connect_attempts_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connect_attempts" ADD CONSTRAINT "connect_attempts_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."connections"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connect_attempts" ADD CONSTRAINT "connect_attempts_created_by_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "public"."member"("organization_id","user_id") ON DELETE SET NULL ("created_by_user_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connect_attempts_tenant_open_idx" ON "connect_attempts" USING btree ("tenant_id","consumed_at","created_at");--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_connect_attempt_fk" FOREIGN KEY ("tenant_id","connect_attempt_id") REFERENCES "public"."connect_attempts"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action" CHECK ("audit_log"."action" in ('connection.created', 'connection.reactivated', 'connection.revoked', 'connection.expired', 'connection.purged', 'connection.reauthorized', 'connect_attempt.rejected', 'card.created', 'card.reopened', 'card.snoozed', 'card.done', 'card.dismissed', 'card.expired', 'action.proposed', 'action.approved', 'action.started', 'action.rejected', 'action.executed', 'action.failed', 'action.reopened', 'fact.confirmed', 'fact.rejected', 'fact.superseded', 'playbook.confirmed', 'playbook.rejected', 'playbook.retired', 'entity.forgotten', 'retention.purged'));--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_object_type" CHECK ("audit_log"."object_type" in ('connections', 'cards', 'actions', 'facts', 'playbooks', 'entities', 'event_contents', 'webhook_deliveries', 'connect_attempts'));--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_status_reason" CHECK ("connections"."status_reason" is null or "connections"."status_reason" in ('invalid_grant', 'provider_revoked', 'user_disconnected', 'reauthorized', 'data_purged', 'auth_recovered', 'account_mismatch'));--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_target" CHECK (num_nonnulls("webhook_deliveries"."connection_id", "webhook_deliveries"."connect_attempt_id") = 1);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "connect_attempts" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("connect_attempts"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("connect_attempts"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);