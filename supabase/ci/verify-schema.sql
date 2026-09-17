-- Post-migration assertions for the CI job in
-- `.github/workflows/migrations.yml`.
--
-- `supabase db reset` already fails on any statement Postgres rejects,
-- so this is not about syntax. It's about the quieter failure: a
-- migration that applies cleanly and does nothing. Every DDL statement
-- in this repo is guarded with IF NOT EXISTS / ON CONFLICT so the files
-- can be re-run safely, and that same guard turns a typo'd object name
-- into a silent no-op with a green checkmark.
--
-- Keep this thin. It is a smoke test for "did the migrations actually
-- build the schema", not a spec of it — asserting every column here
-- would just be the migrations restated in a second place, drifting.
DO $$
BEGIN
  -- The core tables, from 001.
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'public.messages is missing — migrations did not apply';
  END IF;
  IF to_regclass('public.whatsapp_config') IS NULL THEN
    RAISE EXCEPTION 'public.whatsapp_config is missing — migrations did not apply';
  END IF;

  -- Supabase provides the storage schema; migrations 016/020/023 write
  -- to it. If it is absent the bucket migrations silently accomplish
  -- nothing, which is precisely the case a plain "no errors" run hides.
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION
      'storage.buckets is missing — the storage schema was not available when the bucket migrations ran';
  END IF;

  -- Buckets are UPSERTed, so their absence means the INSERT never ran.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'chat-media') THEN
    RAISE EXCEPTION 'the chat-media bucket row was not created (migration 023)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'flow-media') THEN
    RAISE EXCEPTION 'the flow-media bucket row was not created (migration 016)';
  END IF;

  -- Account scoping (017) is load-bearing for every RLS policy.
  IF to_regclass('public.accounts') IS NULL THEN
    RAISE EXCEPTION 'public.accounts is missing — migration 017 did not apply';
  END IF;

  -- The BSUID index (040) is the only thing stopping a username-only
  -- WhatsApp sender from forking a new contact per inbound message. A
  -- typo in its name would apply cleanly and guarantee nothing.
  IF to_regclass('public.idx_contacts_account_wa_user_id') IS NULL THEN
    RAISE EXCEPTION
      'idx_contacts_account_wa_user_id is missing — migration 040 did not apply';
  END IF;

  -- 041 repairs create_broadcast_with_recipients, which 037/038 shipped
  -- with an ambiguous bare `RETURNING id, contact_id` (SQLSTATE 42702 on
  -- first call — plpgsql resolves names at execution, not CREATE, so a
  -- plain replay can't catch it).
  --
  -- The signature asserted here is the 10-argument plain-text overload,
  -- not 041's 8-argument one: migration 049 DROPs the 8-argument
  -- function outright and replaces it, so on this branch the overload
  -- below is the only one that exists and the only one the app calls.
  -- 050 is what carries 041's qualified RETURNING into it — without
  -- that migration this assertion fails, which is the point.
  IF pg_get_functiondef(
       'public.create_broadcast_with_recipients(uuid,uuid,text,text,text,integer,uuid[],jsonb[],text,text)'::regprocedure
     ) NOT LIKE '%RETURNING id, broadcast_recipients.contact_id%' THEN
    RAISE EXCEPTION
      'create_broadcast_with_recipients still has the ambiguous RETURNING — migration 050 did not apply';
  END IF;

  -- Exactly one overload must survive. Two of them (the 8-argument one
  -- 041 creates plus the 10-argument one 049 creates) make any call
  -- that leans on p_send_mode/p_body_text defaults fail with
  -- "function ... is not unique". 050 drops the 8-argument signature
  -- precisely so a database catching up out of order cannot end up
  -- here, and this asserts it worked.
  IF (
    SELECT COUNT(*) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'create_broadcast_with_recipients'
  ) <> 1 THEN
    RAISE EXCEPTION
      'create_broadcast_with_recipients has more than one overload — named-argument calls will be ambiguous';
  END IF;

  -- The failure-reason columns (042) are only ever written by the
  -- status webhook, which uses an untyped update — a missing column
  -- there is a runtime PostgREST error on every failed send, not a
  -- compile error.
  IF (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages'
      AND column_name IN ('error_code', 'error_title', 'error_details')
  ) <> 3 THEN
    RAISE EXCEPTION
      'messages.error_code/error_title/error_details are missing — migration 042 did not apply';
  END IF;

  -- ----------------------------------------------------------------
  -- Fork-only line (Evolution API), migrations 045-049.
  --
  -- These were never asserted, which is how a whole branch of the
  -- schema drifted out of production unnoticed: the numbering
  -- collision that the 040-042 checks above cover only becomes
  -- visible if the fork's own objects are checked too.
  -- ----------------------------------------------------------------

  -- 045: the table every Evolution connection, webhook lookup and
  -- message row hangs off.
  IF to_regclass('public.whatsapp_connections') IS NULL THEN
    RAISE EXCEPTION
      'public.whatsapp_connections is missing — migration 045 did not apply';
  END IF;

  -- 046: inbound idempotency. Without this index a redelivered
  -- webhook silently duplicates the message instead of being skipped.
  IF to_regclass('public.messages_dedup_key') IS NULL THEN
    RAISE EXCEPTION
      'messages_dedup_key is missing — migration 046 did not apply';
  END IF;

  -- 047: the MIME type the inbound media mirror needs to name a file.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages'
      AND column_name = 'media_type'
  ) THEN
    RAISE EXCEPTION 'messages.media_type is missing — migration 047 did not apply';
  END IF;

  -- 048: the reconnect backfill guard.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'whatsapp_connections'
      AND column_name = 'is_syncing'
  ) THEN
    RAISE EXCEPTION
      'whatsapp_connections.is_syncing is missing — migration 048 did not apply';
  END IF;

  -- 049: plain-text broadcasts, the Evolution send mode.
  IF (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'broadcasts'
      AND column_name IN ('send_mode', 'body_text')
  ) <> 2 THEN
    RAISE EXCEPTION
      'broadcasts.send_mode/body_text are missing — migration 049 did not apply';
  END IF;

  -- 051: the "is anything actually arriving" signal. Written by the
  -- webhook on an untyped update, so a missing column is a runtime
  -- PostgREST error on every inbound batch, not a compile error.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'whatsapp_connections'
      AND column_name = 'last_inbound_at'
  ) THEN
    RAISE EXCEPTION
      'whatsapp_connections.last_inbound_at is missing — migration 051 did not apply';
  END IF;

  RAISE NOTICE 'schema verification passed';
END
$$;

-- Two things this file has already been burned by, both verified in CI
-- rather than assumed:
--
-- 1. It must contain EXACTLY ONE statement. `supabase db query --file`
--    sends the whole file as a prepared statement, and a second
--    top-level statement fails with the distinctly unhelpful "cannot
--    insert multiple commands into a prepared statement" (commit
--    f91a6c8). Add assertions INSIDE the DO block above; do not append
--    a second one.
--
-- 2. A RAISE in here really does fail the job. A deliberately false
--    assertion (commit 42c7db0, run 31579334056) surfaced as
--    `failed to execute query: error: ...` and exited 1. This is not a
--    decorative green tick.
