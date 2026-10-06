CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT public.gen_uuid_v7() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"source" text NOT NULL,
	"delivery_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"processed_at" timestamp with time zone,
	CONSTRAINT "webhook_deliveries_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "webhook_deliveries_delivery_unique" UNIQUE("tenant_id","source","delivery_id"),
	CONSTRAINT "webhook_deliveries_source" CHECK ("webhook_deliveries"."source" in ('nango', 'mollie')),
	CONSTRAINT "webhook_deliveries_status" CHECK ("webhook_deliveries"."status" in ('received', 'processed', 'failed')),
	CONSTRAINT "webhook_deliveries_last_error_code" CHECK ("webhook_deliveries"."last_error_code" in ('invalid_payload', 'unknown', 'nango_unavailable')),
	CONSTRAINT "webhook_deliveries_payload_object" CHECK (jsonb_typeof("webhook_deliveries"."payload") = 'object'),
	CONSTRAINT "webhook_deliveries_attempts" CHECK ("webhook_deliveries"."attempts" >= 0),
	CONSTRAINT "webhook_deliveries_processed" CHECK (("webhook_deliveries"."status" = 'processed') = ("webhook_deliveries"."processed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_object_type";--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."connections"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_tenant_status_idx" ON "webhook_deliveries" USING btree ("tenant_id","status","received_at");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_object_type" CHECK ("audit_log"."object_type" in ('connections', 'cards', 'actions', 'facts', 'playbooks', 'entities', 'event_contents', 'webhook_deliveries'));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "webhook_deliveries" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("webhook_deliveries"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("webhook_deliveries"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);