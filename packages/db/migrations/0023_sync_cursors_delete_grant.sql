-- Purging a connection removes its cursor (docs/integrations.md §5.3): the
-- connection row stays as a tombstone, so the cascade never fires.
GRANT DELETE ON "sync_cursors" TO app_runtime;
