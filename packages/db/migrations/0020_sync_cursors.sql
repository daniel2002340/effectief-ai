CREATE TABLE "sync_cursors" (
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"model" text NOT NULL,
	"cursor" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_cursors_tenant_id_connection_id_model_pk" PRIMARY KEY("tenant_id","connection_id","model"),
	CONSTRAINT "sync_cursors_model" CHECK ("sync_cursors"."model" in ('InboxMessage'))
);
--> statement-breakpoint
ALTER TABLE "sync_cursors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action";--> statement-breakpoint
ALTER TABLE "event_contents" ADD COLUMN "from_name" text;--> statement-breakpoint
ALTER TABLE "event_contents" ADD COLUMN "cc_addresses" text[];--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."connections"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action" CHECK ("audit_log"."action" in ('connection.created', 'connection.reactivated', 'connection.revoked', 'connection.expired', 'connection.purged', 'connection.reauthorized', 'connect_attempt.rejected', 'card.created', 'card.reopened', 'card.snoozed', 'card.done', 'card.dismissed', 'card.expired', 'action.proposed', 'action.approved', 'action.started', 'action.rejected', 'action.executed', 'action.failed', 'action.reopened', 'fact.confirmed', 'fact.rejected', 'fact.superseded', 'playbook.confirmed', 'playbook.rejected', 'playbook.retired', 'entity.forgotten', 'retention.purged', 'mail.ingested', 'mail.content_removed'));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sync_cursors" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("sync_cursors"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("sync_cursors"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);