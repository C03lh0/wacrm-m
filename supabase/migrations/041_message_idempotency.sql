-- ============================================================
-- 041_message_idempotency
--
-- Adds a provider-aware idempotency key for messages so webhook
-- retries (Meta's own retry behavior, and Evolution's) can no longer
-- double-insert. Today's `idx_messages_message_id` (migration 001)
-- is deliberately non-unique — migration 009 explains Meta's wamid
-- can repeat across different phone numbers on the same Meta app, so
-- a naive UNIQUE(message_id) would be wrong. The dedup key here is
-- scoped by (provider, connection_id, provider_message_id) instead,
-- which is unique per connection regardless of what the provider's
-- own id namespace looks like.
--
-- This is a deliberate, small, in-scope touch to the Meta code path:
-- src/app/api/whatsapp/webhook/route.ts's processMessage() now does a
-- lookup-then-insert-then-resolve-on-conflict before inserting an
-- inbound message, exactly mirroring the existing house pattern for
-- contacts (022_contact_phone_dedup) and conversations
-- (036_conversation_contact_dedup). Everything else about Meta's
-- webhook handling is unchanged.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta'
  CHECK (provider IN ('meta', 'evolution'));

-- Logical reference only — not a real FK, since it can point at
-- either whatsapp_config.id (provider = 'meta') or
-- whatsapp_connections.id (provider = 'evolution'), and Postgres FKs
-- cannot target two different tables. Enforced in application code
-- (provider-factory.ts / the inbound pipeline), documented here.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS connection_id UUID;

-- Copy of the existing `message_id` column going forward, kept
-- separately so the dedup key's meaning is self-contained; the
-- original `message_id` column is untouched for backward
-- compatibility with every existing read site (status webhooks,
-- reply-context resolution, etc.).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_message_id TEXT;

-- Backfill existing rows: provider='meta' (the DEFAULT above already
-- covers this), connection_id = the account's current
-- whatsapp_config.id (best-effort join on account_id via
-- conversations, since historical rows have no direct FK to config),
-- provider_message_id = message_id.
UPDATE messages m
SET connection_id = wc.id,
    provider_message_id = m.message_id
FROM conversations c
JOIN whatsapp_config wc ON wc.account_id = c.account_id
WHERE c.id = m.conversation_id
  AND m.connection_id IS NULL
  AND m.message_id IS NOT NULL;

-- Authoritative dedup guarantee. Partial index — outbound sends and
-- historical rows with no resolvable provider_message_id/connection_id
-- are excluded rather than colliding on NULL (Postgres treats NULLs as
-- distinct in a unique index, but the WHERE clause makes the intent
-- explicit and keeps the index small).
CREATE UNIQUE INDEX IF NOT EXISTS messages_dedup_key
  ON messages (provider, connection_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL AND connection_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_connection
  ON messages(connection_id);
