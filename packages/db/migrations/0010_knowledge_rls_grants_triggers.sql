-- RLS, privileges, status guards and vector indexes for knowledge
-- (docs/data-model.md §3.5, §4 part B and C, §5). drizzle-kit generates
-- neither FORCE ROW LEVEL SECURITY, grants, triggers nor expression indexes.
ALTER TABLE "facts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fact_embeddings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "playbooks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "playbook_examples" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "playbook_embeddings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "document_chunks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "chunk_embeddings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "document_entities" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "company_profile" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "insights" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Facts: content is immutable; correcting is a new fact that ends the old one
-- (valid_to, superseded_by_id). Never deleted by the app, only by cascade.
GRANT SELECT, INSERT ON "facts" TO app_runtime;
--> statement-breakpoint
GRANT UPDATE ("status", "valid_to", "superseded_by_id", "confirmed_by_user_id", "confirmed_at", "last_confirmed_at", "updated_at") ON "facts" TO app_runtime;
--> statement-breakpoint
-- Playbooks: content is immutable; a change is a new version.
GRANT SELECT, INSERT ON "playbooks" TO app_runtime;
--> statement-breakpoint
GRANT UPDATE ("status", "confirmed_by_user_id", "confirmed_at", "updated_at") ON "playbooks" TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "documents" TO app_runtime;
--> statement-breakpoint
GRANT UPDATE ("status", "title", "updated_at") ON "documents" TO app_runtime;
--> statement-breakpoint
-- Chunks go with their document (cascade).
GRANT SELECT, INSERT ON "document_chunks" TO app_runtime;
--> statement-breakpoint
-- Embeddings are immutable; DELETE is for re-embedding with a new model.
GRANT SELECT, INSERT, DELETE ON "playbook_examples", "document_entities", "fact_embeddings", "playbook_embeddings", "chunk_embeddings" TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "company_profile" TO app_runtime;
--> statement-breakpoint
-- Recomputable: upsert and delete freely.
GRANT SELECT, INSERT, UPDATE, DELETE ON "insights" TO app_runtime;
--> statement-breakpoint
-- Status transitions (decision #044, functions from migration 0008). The
-- pairs match factTransitions and playbookTransitions in
-- packages/shared/src/domain/transitions.ts; knowledge.test.ts compares them.
CREATE TRIGGER facts_initial_status
  BEFORE INSERT ON "facts"
  FOR EACH ROW EXECUTE FUNCTION public.initial_status_guard('proposed');
--> statement-breakpoint
CREATE TRIGGER playbooks_initial_status
  BEFORE INSERT ON "playbooks"
  FOR EACH ROW EXECUTE FUNCTION public.initial_status_guard('proposed');
--> statement-breakpoint
CREATE TRIGGER facts_status_guard
  BEFORE UPDATE OF "status" ON "facts"
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.status_transition_guard(
    'proposed:confirmed', 'proposed:rejected'
  );
--> statement-breakpoint
CREATE TRIGGER playbooks_status_guard
  BEFORE UPDATE OF "status" ON "playbooks"
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.status_transition_guard(
    'proposed:confirmed', 'proposed:rejected',
    'confirmed:retired'
  );
--> statement-breakpoint
-- An ended fact stays ended: valid_to and superseded_by_id are set once.
-- superseded_by_id may still become NULL through the foreign key (the newer
-- fact was deleted by forget); that runs at trigger depth > 1.
CREATE FUNCTION public.facts_end_once() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.valid_to IS NOT NULL AND NEW.valid_to IS DISTINCT FROM OLD.valid_to THEN
    RAISE EXCEPTION 'facts.valid_to cannot be changed once set (fact %)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.superseded_by_id IS NOT NULL
     AND NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id
     AND pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'facts.superseded_by_id cannot be changed once set (fact %)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER facts_end_once
  BEFORE UPDATE OF "valid_to", "superseded_by_id" ON "facts"
  FOR EACH ROW EXECUTE FUNCTION public.facts_end_once();
--> statement-breakpoint
-- HNSW per active embedding space (docs/data-model.md §3.5): a partial
-- expression index with the fixed dimension of the space. Search queries use
-- exactly this expression and predicate. A new space in
-- packages/ai/models.ts needs a migration with its own index.
CREATE INDEX "fact_embeddings_cohere_embed_v5_hnsw" ON "fact_embeddings"
  USING hnsw (("embedding"::vector(1024)) vector_cosine_ops)
  WHERE "model" = 'cohere-embed-v5' AND "dimensions" = 1024;
--> statement-breakpoint
CREATE INDEX "playbook_embeddings_cohere_embed_v5_hnsw" ON "playbook_embeddings"
  USING hnsw (("embedding"::vector(1024)) vector_cosine_ops)
  WHERE "model" = 'cohere-embed-v5' AND "dimensions" = 1024;
--> statement-breakpoint
CREATE INDEX "chunk_embeddings_cohere_embed_v5_hnsw" ON "chunk_embeddings"
  USING hnsw (("embedding"::vector(1024)) vector_cosine_ops)
  WHERE "model" = 'cohere-embed-v5' AND "dimensions" = 1024;
--> statement-breakpoint
-- How often a playbook was applied, derived from executed actions instead of
-- a counter (docs/data-model.md, playbooks). security_invoker: the RLS of
-- playbooks and actions applies to whoever reads the view.
CREATE VIEW "playbook_usage" WITH (security_invoker = true) AS
  SELECT p.tenant_id,
         p.id AS playbook_id,
         count(a.id) FILTER (WHERE a.status = 'executed')::int AS times_applied,
         max(a.executed_at) AS last_applied_at
    FROM "playbooks" p
    LEFT JOIN "actions" a ON a.tenant_id = p.tenant_id AND a.playbook_id = p.id
   GROUP BY p.tenant_id, p.id;
--> statement-breakpoint
GRANT SELECT ON "playbook_usage" TO app_runtime;
