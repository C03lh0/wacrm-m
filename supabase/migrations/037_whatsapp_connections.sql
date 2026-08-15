-- ============================================================
-- 037_whatsapp_connections
--
-- Introduces a provider-agnostic `whatsapp_connections` table for
-- Evolution API (and any future non-Meta provider), while leaving
-- `whatsapp_config` (Meta Cloud API) completely untouched — every
-- existing Meta code path keeps reading/writing whatsapp_config
-- exactly as before. `whatsapp_connections` is Evolution-only for
-- now; a future migration could backfill whatsapp_config rows into a
-- unified table, but that is out of scope here and NOT required for
-- this feature.
--
-- One connection per account, mirroring whatsapp_config's own
-- one-row-per-account rule (migration 017) — from the settings UI's
-- perspective, an account has one WhatsApp number, on one provider.
-- Drop the unique index + add an `is_primary` boolean later if
-- multi-number-per-account is ever wanted (whatsapp_config's own
-- migration-017 comment anticipates the same future change).
--
-- No per-account Evolution credential column: EVOLUTION_API_KEY is a
-- single instance-wide secret (env var), not per-tenant, so there is
-- nothing analogous to whatsapp_config.access_token to store here —
-- the cleanest possible separation from Meta's per-account encrypted
-- token.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_connections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Audit / sender-of-record column, same role as whatsapp_config.user_id:
  -- the admin who created the connection. Used as the NOT NULL user_id FK
  -- on contact/conversation inserts made from this connection's webhook.
  created_by_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL DEFAULT 'evolution' CHECK (provider IN ('evolution')),

  -- Evolution's own instance identifier — this is the tenancy-
  -- resolution key for inbound webhooks, the direct equivalent of
  -- Meta's globally-unique phone_number_id (migration 013).
  instance_name TEXT NOT NULL,

  -- Normalized lifecycle status, provider-vocabulary-independent —
  -- see src/lib/whatsapp/evolution-status.ts for the raw-to-internal
  -- mapping. Nothing outside that mapper should compare against
  -- Evolution's own raw status strings.
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'connecting', 'qr_required', 'connected', 'disconnected', 'error')),

  phone_number TEXT,
  display_name TEXT,

  qr_code TEXT,
  qr_expires_at TIMESTAMPTZ,

  -- Encrypted (src/lib/whatsapp/encryption.ts) — only populated if the
  -- target Evolution deployment supports a per-instance webhook auth
  -- secret/signature. Never logged, never returned to the frontend.
  webhook_secret TEXT,

  last_error TEXT,
  connected_at TIMESTAMPTZ,
  disconnected_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_connections_account_id_key
  ON whatsapp_connections(account_id);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_connections_instance_name_key
  ON whatsapp_connections(instance_name);

CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_account
  ON whatsapp_connections(account_id);

DROP TRIGGER IF EXISTS set_updated_at ON whatsapp_connections;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON whatsapp_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE whatsapp_connections ENABLE ROW LEVEL SECURITY;

-- Same tier as whatsapp_config (settings-class): viewers/agents read,
-- admins+ manage the connection.
DROP POLICY IF EXISTS whatsapp_connections_select ON whatsapp_connections;
CREATE POLICY whatsapp_connections_select ON whatsapp_connections FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS whatsapp_connections_insert ON whatsapp_connections;
CREATE POLICY whatsapp_connections_insert ON whatsapp_connections FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS whatsapp_connections_update ON whatsapp_connections;
CREATE POLICY whatsapp_connections_update ON whatsapp_connections FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS whatsapp_connections_delete ON whatsapp_connections;
CREATE POLICY whatsapp_connections_delete ON whatsapp_connections FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- ENABLE REALTIME
--
-- The Evolution webhook (server-side) updates status/qr_code as
-- connection events arrive; the settings UI subscribes via
-- postgres_changes instead of polling Evolution directly.
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'whatsapp_connections'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_connections;
  END IF;
END $$;
