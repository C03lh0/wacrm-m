-- ============================================================
-- 039_contact_opt_out
--
-- Adds opt-out tracking for contacts so Broadcast can refuse to send
-- to someone who asked not to receive bulk messages. Today nothing in
-- the CRM enforces consent at all — Meta's own template-approval
-- process is a *content* backstop, not a *consent* one, and it
-- doesn't exist at all on Evolution (WhatsApp Web), which has no
-- approval workflow and a real account-ban risk for unsolicited bulk
-- sending. This column benefits both providers; the practical urgency
-- is highest for Evolution.
--
-- `opted_out_at` is a nullable timestamp rather than a boolean so it
-- captures *when* the contact opted out for free, and NULL (= "not
-- opted out") is exactly today's implicit behavior for every existing
-- row — no backfill needed, no existing broadcast's recipient count
-- changes on migration day.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS opted_out_at TIMESTAMPTZ;

-- Supports the broadcast-recipient-resolution filter cheaply. Partial
-- index — most contacts are never opted out, so indexing only the
-- ones that are keeps this small (mirrors the style of
-- messages_dedup_key in migration 038).
CREATE INDEX IF NOT EXISTS idx_contacts_opted_out
  ON contacts(opted_out_at)
  WHERE opted_out_at IS NOT NULL;
