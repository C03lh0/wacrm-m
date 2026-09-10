-- ============================================================
-- 044_broadcast_plain_text
--
-- Broadcasts have been 100% template-based (Meta-only) since 001 —
-- templates are a Meta Cloud API concept, and Evolution/Baileys-style
-- connections have no template-approval workflow at all. That's left
-- Evolution-connected accounts unable to broadcast, full stop.
--
-- This adds a second, provider-appropriate mode: a plain-text
-- broadcast (no template, just a body + the same {{1}}/{{2}}
-- positional-variable substitution templates already use), sent via
-- WhatsAppProviderClient.sendText — which every provider implements,
-- unlike the optional sendTemplate. `send_mode` discriminates the two;
-- every pre-migration row is unambiguously 'template' by default, no
-- backfill needed.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS send_mode TEXT NOT NULL DEFAULT 'template'
    CHECK (send_mode IN ('template', 'plain_text')),
  ADD COLUMN IF NOT EXISTS body_text TEXT;

COMMENT ON COLUMN broadcasts.send_mode IS
  '''template'' (Meta, approved template, default) or ''plain_text'' (Evolution, free-text body). See 044_broadcast_plain_text.sql.';
COMMENT ON COLUMN broadcasts.body_text IS
  'Plain-text body for send_mode=''plain_text'' broadcasts, with {{1}}/{{2}}-style positional placeholders resolved the same way template_variables are. NULL for send_mode=''template'' rows.';

-- template_name/template_language are only meaningful for send_mode =
-- 'template'; drop the blanket NOT NULL and replace it with a
-- mode-aware CHECK so a plain-text row doesn't need a fake template
-- name, and a template row can never be missing one.
ALTER TABLE broadcasts
  ALTER COLUMN template_name DROP NOT NULL,
  ALTER COLUMN template_language DROP NOT NULL;

ALTER TABLE broadcasts
  DROP CONSTRAINT IF EXISTS broadcasts_send_mode_fields_check;
ALTER TABLE broadcasts
  ADD CONSTRAINT broadcasts_send_mode_fields_check CHECK (
    (send_mode = 'template' AND template_name IS NOT NULL)
    OR (send_mode = 'plain_text' AND body_text IS NOT NULL)
  );

-- ============================================================
-- create_broadcast_with_recipients — carry send_mode/body_text
--
-- Dropped rather than CREATE OR REPLACE'd: adding parameters makes a
-- new overload, and DEFAULTs on them would leave the 8-argument call
-- from 038 ambiguous between the two (same reasoning 038 documented
-- when it did this to 037's version).
-- ============================================================
DROP FUNCTION IF EXISTS public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[]
);

CREATE OR REPLACE FUNCTION public.create_broadcast_with_recipients(
  p_account_id        UUID,
  p_user_id           UUID,
  p_name              TEXT,
  p_template_name     TEXT,
  p_template_language TEXT,
  p_total_recipients  INTEGER,
  p_contact_ids       UUID[],
  p_template_params   JSONB[],
  p_send_mode         TEXT DEFAULT 'template',
  p_body_text         TEXT DEFAULT NULL
)
RETURNS TABLE(broadcast_id UUID, recipient_id UUID, contact_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_broadcast_id UUID;
BEGIN
  INSERT INTO broadcasts (
    account_id, user_id, name, template_name,
    template_language, status, total_recipients,
    send_mode, body_text
  )
  VALUES (
    p_account_id, p_user_id, p_name, p_template_name,
    p_template_language, 'sending', p_total_recipients,
    p_send_mode, p_body_text
  )
  RETURNING id INTO v_broadcast_id;

  -- Two-array unnest pairs each contact with its params positionally.
  -- A shorter params array pads with NULL, which the resume path reads
  -- as "no params" — the same as a pre-038 row.
  RETURN QUERY
  WITH ins AS (
    INSERT INTO broadcast_recipients (
      broadcast_id, contact_id, status, template_params
    )
    SELECT v_broadcast_id, t.cid, 'pending', t.prm
    FROM unnest(p_contact_ids, p_template_params) AS t(cid, prm)
    RETURNING id, contact_id
  )
  SELECT v_broadcast_id, ins.id, ins.contact_id
  FROM ins;
END;
$$;

REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], TEXT, TEXT) TO service_role;
