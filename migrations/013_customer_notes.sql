-- Migration 013: customer_notes table
-- Date: 2026-05-26
-- Purpose: Aparte tabel voor klant-notities (granulair, eigen audit-spoor).
--          Vervangt het customers.notes textarea-veld (blijft staan voor backward
--          compatibility, wordt gedeprecateerd).
-- Idempotent (IF NOT EXISTS / DROP+CREATE policies).
-- Pattern: consistent met migration 012 (RLS DO-block-loop, set_updated_at trigger).

BEGIN;

-- ============================================================================
-- 1) customer_notes — granulaire notities per klant
-- ============================================================================
CREATE TABLE IF NOT EXISTS customer_notes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id         uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  body                text NOT NULL,
  created_by_user_id  uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  edited_at           timestamptz,
  archived_at         timestamptz
);

-- Lookup-pad: alle actieve notities voor een klant, nieuwste eerst.
CREATE INDEX IF NOT EXISTS idx_customer_notes_customer
  ON customer_notes(customer_id, created_at DESC)
  WHERE archived_at IS NULL;

-- ============================================================================
-- 2) updated_at-trigger — hergebruikt public.set_updated_at() uit migratie 012
-- ============================================================================
DROP TRIGGER IF EXISTS trg_customer_notes_updated ON customer_notes;
CREATE TRIGGER trg_customer_notes_updated BEFORE UPDATE ON customer_notes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- 3) RLS — zelfde idioom als migratie 003/012 (auth read / super_admin write).
--    Schrijven gebeurt in Fase 2A.4 via service-role ná permission-checks op de
--    API-laag (customer.notes.write).
-- ============================================================================
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT unnest(ARRAY['customer_notes']) LOOP
    EXECUTE format('ALTER TABLE %1$s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "auth read %1$s" ON %1$s', t);
    EXECUTE format('CREATE POLICY "auth read %1$s" ON %1$s FOR SELECT TO authenticated USING (true)', t);
    EXECUTE format('DROP POLICY IF EXISTS "super admin write %1$s" ON %1$s', t);
    EXECUTE format('CREATE POLICY "super admin write %1$s" ON %1$s FOR ALL TO authenticated USING (public.is_super_admin()) WITH CHECK (public.is_super_admin())', t);
  END LOOP;
END $$;

-- ============================================================================
-- 4) Deprecatie-marker op customers.notes
-- ============================================================================
COMMENT ON COLUMN customers.notes IS
  'DEPRECATED (vanaf migratie 013): gebruik customer_notes-tabel voor nieuwe notities. '
  'Bestaande tekst blijft staan voor backward compatibility.';

COMMIT;

-- ============================================================================
-- VALIDATIE (handmatig in SQL Editor)
-- ============================================================================
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema='public' AND table_name='customer_notes';                -- 1 rij
-- SELECT relrowsecurity FROM pg_class WHERE relname='customer_notes';           -- true
-- SELECT polname FROM pg_policy WHERE polrelid='customer_notes'::regclass;      -- 2 policies
-- SELECT tgname FROM pg_trigger WHERE tgrelid='customer_notes'::regclass;       -- trg_customer_notes_updated
-- SELECT col_description('customers'::regclass, attnum) FROM pg_attribute
--   WHERE attrelid='customers'::regclass AND attname='notes';                   -- DEPRECATED-tekst
