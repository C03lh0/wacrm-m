-- ============================================================
-- 050_fix_broadcast_plain_text_contact_id_ambiguity.sql — carry
--     migration 041's fix into the plain-text overload
--
-- The problem
--
--   Migration 041 (upstream) fixed SQLSTATE 42702 in
--   `create_broadcast_with_recipients`:
--
--     column reference "contact_id" is ambiguous
--     It could refer to either a PL/pgSQL variable or a table column.
--
--   The function is declared
--   `RETURNS TABLE(broadcast_id UUID, recipient_id UUID, contact_id UUID)`,
--   and in PL/pgSQL a RETURNS TABLE output column is ALSO an in-scope
--   variable, so a bare `RETURNING id, contact_id` resolves against
--   both the target table's column and the function's own output
--   parameter. 041 qualified it as `broadcast_recipients.contact_id`.
--
--   That fix landed on the 8-argument signature
--   (..., UUID[], JSONB[]). Migration 049 — this fork's plain-text
--   broadcasts — then DROPs that exact signature and creates a
--   10-argument overload (..., p_send_mode, p_body_text) whose body
--   was written against the PRE-041 source and still carries the
--   unqualified `RETURNING id, contact_id`.
--
--   The two migrations were developed on separate branches and the
--   merge kept both, so on any database that has 049 the only
--   surviving overload is the broken one: every call to
--   POST /api/v1/broadcasts dies in the database again.
--
-- The fix
--
--   Replace the 10-argument body with 041's qualified RETURNING.
--   Nothing else about the function changes — same signature, same
--   parameters, same return shape, same SECURITY DEFINER settings.
--
-- Why a separate migration rather than editing 049 in place: 049 has
-- already been applied to live databases, so the corrected body has to
-- arrive as its own step. CREATE OR REPLACE keeps existing grants, and
-- re-asserting them below keeps this file correct in isolation.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- Drop the 8-argument signature first, and unconditionally.
--
-- 049 already dropped it, so on a clean replay this is a no-op. It
-- matters on a database catching up out of order: applying 041 to a
-- database that already has 049 RE-CREATES the 8-argument function,
-- and the two overloads then coexist. VERIFIED against a replica of
-- the affected production schema — with both present, a call that
-- omits p_send_mode/p_body_text fails with
--
--   function ... is not unique
--
-- because named-argument resolution cannot choose between the exact
-- 8-argument match and the 10-argument one filling its defaults.
-- Today's only caller passes all ten, so it resolves; anything relying
-- on the defaults would not. Dropping here makes the end state one
-- overload regardless of the order these files were applied in.
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
    -- Qualified, per migration 041: an unqualified `contact_id` here
    -- is ambiguous against this function's own RETURNS TABLE column.
    RETURNING id, broadcast_recipients.contact_id
  )
  SELECT v_broadcast_id, ins.id, ins.contact_id
  FROM ins;
END;
$$;

REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], TEXT, TEXT) TO service_role;
