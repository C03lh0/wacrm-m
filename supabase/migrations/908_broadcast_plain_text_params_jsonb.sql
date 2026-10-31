-- ============================================================
-- 908_broadcast_plain_text_params_jsonb.sql — carry upstream's JSONB
--     pairing fix into this fork's plain-text overload
--
-- The problem
--
--   Upstream's 049 replaced `p_template_params JSONB[]` with a single
--   `JSONB` (an array of arrays paired by ordinality) because PostgREST
--   flattens a JSONB[] argument into a 2-D scalar array: the per-
--   recipient params stop lining up with p_contact_ids, so recipient #2
--   can be sent recipient #1's {{1}}. That fix landed on the
--   8-argument signature.
--
--   This fork's 10-argument overload (905/906 — `p_send_mode` and
--   `p_body_text` for plain-text broadcasts, which Evolution needs
--   because it has no template approval) still takes JSONB[], so every
--   multi-recipient broadcast through POST /api/v1/broadcasts carries
--   the same mis-pairing.
--
--   Second problem, new since upstream's 049: its 8-argument function
--   now exists again alongside this overload, and this overload
--   defaulted `p_send_mode` / `p_body_text`. Two candidates for an
--   8-argument call means PostgreSQL raises "function ... is not
--   unique" instead of picking one.
--
-- The fix
--
--   Drop the JSONB[] 10-argument overload and recreate it taking
--   `p_template_params JSONB`, with upstream's validation and
--   ordinality join, the fork's send_mode/body_text columns, and 041's
--   qualified RETURNING. The defaults are gone on purpose: the only
--   caller (createBroadcast in src/lib/whatsapp/broadcast-core.ts)
--   always passes all ten arguments, and without defaults this
--   signature can never collide with upstream's 8-argument one.
--
-- Why a separate migration rather than editing 905/906 in place: both
-- have already been applied to live databases, so the corrected body
-- has to arrive as its own step.
-- ============================================================

DROP FUNCTION IF EXISTS public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], TEXT, TEXT
);

CREATE OR REPLACE FUNCTION public.create_broadcast_with_recipients(
  p_account_id        UUID,
  p_user_id           UUID,
  p_name              TEXT,
  p_template_name     TEXT,
  p_template_language TEXT,
  p_total_recipients  INTEGER,
  p_contact_ids       UUID[],
  p_template_params   JSONB,
  p_send_mode         TEXT,
  p_body_text         TEXT
)
RETURNS TABLE(broadcast_id UUID, recipient_id UUID, contact_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_broadcast_id UUID;
BEGIN
  IF p_template_params IS NULL OR jsonb_typeof(p_template_params) <> 'array' THEN
    RAISE EXCEPTION 'p_template_params must be a JSON array with one params array per contact'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_template_params) <> COALESCE(cardinality(p_contact_ids), 0) THEN
    RAISE EXCEPTION 'p_template_params has % entries but p_contact_ids has %',
      jsonb_array_length(p_template_params), COALESCE(cardinality(p_contact_ids), 0)
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_template_params) AS params(value)
    WHERE jsonb_typeof(params.value) <> 'array'
  ) THEN
    RAISE EXCEPTION 'every p_template_params entry must be a JSON array'
      USING ERRCODE = '22023';
  END IF;

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

  -- Joined on ordinality rather than unnest(a, b): that pairing is what
  -- survives PostgREST's handling of the argument.
  RETURN QUERY
  WITH ins AS (
    INSERT INTO broadcast_recipients (
      broadcast_id, contact_id, status, template_params
    )
    SELECT v_broadcast_id, contacts_in.cid, 'pending', params_in.prm
    FROM unnest(p_contact_ids) WITH ORDINALITY AS contacts_in(cid, ordinal)
    JOIN jsonb_array_elements(p_template_params) WITH ORDINALITY AS params_in(prm, ordinal)
      ON params_in.ordinal = contacts_in.ordinal
    ORDER BY contacts_in.ordinal
    -- Qualified, per migration 041: an unqualified `contact_id` here is
    -- ambiguous against this function's own RETURNS TABLE column.
    RETURNING id, broadcast_recipients.contact_id
  )
  SELECT v_broadcast_id, ins.id, ins.contact_id
  FROM ins;
END;
$$;

REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB, TEXT, TEXT) TO service_role;
