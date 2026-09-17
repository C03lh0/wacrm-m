-- ============================================================
-- 051_whatsapp_connections_last_inbound_at
--
-- Record when a connection last actually received something.
--
-- Why this exists: a connection went 19 days without delivering a
-- single inbound message while `status` read 'connected' the whole
-- time, and nothing anywhere could tell the difference. Every signal
-- the system had was about the SESSION — Evolution's connectionState,
-- the webhook's CONNECTION_UPDATE events — and all of them said the
-- session was fine. None of them was about whether messages were
-- arriving, which is the only thing the user actually cares about.
--
-- `last_inbound_at` is that missing signal, and it is the cheapest one
-- available: the inbound path already writes to the database on every
-- message, so stamping it costs nothing extra and needs no polling.
--
-- Deliberately NOT NULL-defaulted to now(): a connection that has
-- never received anything must be distinguishable from one that
-- received something this second. NULL means "nothing yet".
--
-- No backfill. The message rows carry their own `created_at`, so the
-- historical answer is recoverable by query; guessing a value here
-- would only invent silence or invent activity.
--
-- Idempotent. Additive only.
-- ============================================================

ALTER TABLE whatsapp_connections
  ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ;

COMMENT ON COLUMN whatsapp_connections.last_inbound_at IS
  'When this connection last received an inbound message, stamped by the '
  'provider webhook. NULL means nothing has ever arrived. A "connected" '
  'row whose last_inbound_at is far in the past is the signature of a '
  'zombie session or a webhook delivering to the wrong URL — neither of '
  'which shows up in the session status.';
