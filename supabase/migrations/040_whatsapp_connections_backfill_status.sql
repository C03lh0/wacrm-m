-- ============================================================
-- 040_whatsapp_connections_backfill_status
--
-- Adds an `is_syncing` flag to whatsapp_connections so the inbox UI can
-- show a blocking "syncing..." overlay while the post-reconnect
-- message backfill (src/lib/whatsapp/evolution-backfill.ts) is
-- catching up on messages missed while the Evolution session was
-- down. Read by src/lib/whatsapp/connection-status.ts, written by
-- backfillMissedMessages() itself — on before paging starts, off in a
-- `finally` so a mid-backfill failure never leaves the inbox stuck.
--
-- Defaults to false so every existing row (and every row before its
-- first backfill run) reads as "not syncing" — no migration-day
-- behavior change for anyone not mid-backfill.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE whatsapp_connections ADD COLUMN IF NOT EXISTS is_syncing BOOLEAN NOT NULL DEFAULT false;
