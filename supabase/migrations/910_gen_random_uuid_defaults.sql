-- ============================================================
-- 910_gen_random_uuid_defaults — retire uuid-ossp on databases that
--     were created before upstream's 98c4171
--
-- Upstream rewrote every `DEFAULT uuid_generate_v4()` in 001-035 to
-- `gen_random_uuid()` so a fresh `supabase db push` to a hosted project
-- stops failing with 42883: on hosted Supabase uuid-ossp lands in the
-- `extensions` schema, which is not on the search_path a migration runs
-- under, so `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"` succeeds and
-- the very next CREATE TABLE cannot resolve the function.
--
-- That rewrite only helps a NEW database. Every statement it touched
-- sits inside `CREATE TABLE IF NOT EXISTS`, so on a database where
-- those tables already exist the files re-apply as no-ops and the
-- columns keep their old uuid_generate_v4() default. Both defaults
-- produce a v4 UUID, so nothing is broken today — but the dependency on
-- uuid-ossp survives, and `supabase/ci/verify-schema.sql` (which
-- rejects any public column default still calling it) fails against
-- such a database.
--
-- This normalises the existing columns so an already-deployed project
-- converges on the same schema a fresh push produces. It is a pure
-- DEFAULT swap: no rows are read or rewritten, no column is retyped,
-- and existing ids are untouched.
--
-- Table-driven rather than a list of ALTERs, because the set of columns
-- to fix depends on when the database was created: a project pushed
-- after 98c4171 has none and this migration is a no-op there.
--
-- Idempotent — safe to re-run.
-- ============================================================

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema
     AND t.table_name = c.table_name
     AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public'
      AND c.column_default LIKE '%uuid_generate_v%'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN %I SET DEFAULT gen_random_uuid()',
      r.table_name,
      r.column_name
    );
    RAISE NOTICE 'default swapped: public.%.%', r.table_name, r.column_name;
  END LOOP;
END $$;

-- The extension itself is deliberately NOT dropped. `DROP EXTENSION
-- "uuid-ossp"` would fail on any object this migration cannot see
-- (a function body calling uuid_generate_v4(), a default on a table
-- outside `public`), and leaving an unused extension installed costs
-- nothing. 001 still creates it, so a fresh database that never needed
-- it is unaffected either way.
