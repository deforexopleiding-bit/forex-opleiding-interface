-- ============================================================================
-- Migratie 041: RLS hardening — [H-07 + H-08 + M-05]
-- Datum: 2026-08-25
-- STATUS: PLAN-ONLY. NIET automatisch draaien. Eerst test-env + review met Jeffrey.
-- ============================================================================
--
-- ⚠ INCASSO-KRUISPUNT: `customers`, `audit_log`, `whatsapp_messages` worden
--    óók door de incasso-zone (finance/dunning-endpoints) gelezen. Alle
--    incasso-endpoints gebruiken echter `supabaseAdmin` (service-role-key)
--    die RLS BYPASST — dus deze migratie raakt de incasso-flows NIET.
--    Rollback ligt klaar onderaan als iets wél breekt.
--
-- ⚠ V1-BREUK-RISICO: elke endpoint die `createUserClient(req)` gebruikt
--    (JWT-scoped, dus WEL door RLS geraakt) moet nog CRM-staff-rol hebben
--    OF via `supabaseAdmin` gaan. Grep-uitkomst voor grep -l 'createUserClient':
--      - api/dashboard-stats.js
--      - api/mentor-*-*.js (grote set — dual-gate)
--      - api/sales-signed-deals-total.js
--      - api/sales-mrr-report.js
--      - api/mentor-coaching-earnings.js
--      - api/mentor-bonus-overview.js
--      - api/finance-*-list-self.js
--    Deze zijn allemaal Bearer-gegate op CRM-staff-rollen, dus `is_crm_staff()`
--    laat ze door. VERIFIEER na deploy: mentor Seppe kan zijn coaching zien,
--    sales Dave kan zijn dashboard zien.
--
-- Bevat 3 domeinen:
--   [H-07] Tabellen expliciet zonder RLS → RLS aanzetten + policies.
--   [H-08] Permissive `USING (true)` policies → vervangen door role-check.
--   [M-05] `FORCE ROW LEVEL SECURITY` op gevoelige tabellen zodat table-owner
--          + SECURITY DEFINER-functies niet stil bypassen.
--
-- Rollback: zie sectie ROLLBACK onderaan.
-- ============================================================================

BEGIN;

-- ── 0. Helper-functie: `is_crm_staff()` ────────────────────────────────────
-- Retourneert true als de huidige JWT hoort bij een profile met een CRM-
-- staff-rol (super_admin/admin/manager/sales/mentor/marketing/administratie)
-- én is_active=true. STABLE + SECURITY DEFINER zodat 'ie RLS op profiles zelf
-- niet triggert (anders infinite loop). SEARCH_PATH gepind tegen search-path-
-- injectie in extensions.
CREATE OR REPLACE FUNCTION public.is_crm_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND is_active = true
      AND role IN ('super_admin', 'admin', 'manager', 'sales', 'mentor', 'marketing', 'administratie')
  );
$$;

REVOKE ALL ON FUNCTION public.is_crm_staff() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_crm_staff() TO authenticated;

-- ── 1. [H-07] Tabellen die nu ZONDER RLS staan → aanzetten ─────────────────
-- Bron: api/db-migrate-batch-meetings.js (team_members, decisions,
-- agent_audit_log), api/db-migrate.js (learn_examples, email_patterns,
-- kennisbank_items, email_actions, email_replies), api/db-migrate-email-
-- bodies.js (backfill_body_progress).
--
-- Model: read = CRM-staff; write = super_admin (via bestaande is_super_admin()).
DO $$
DECLARE
  t text;
  read_tables text[] := ARRAY[
    'team_members', 'decisions', 'agent_audit_log',
    'learn_examples', 'email_patterns', 'kennisbank_items',
    'email_actions', 'email_replies', 'backfill_body_progress'
  ];
BEGIN
  FOREACH t IN ARRAY read_tables LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      -- SELECT voor CRM-staff.
      EXECUTE format('DROP POLICY IF EXISTS "crm staff read %1$s" ON public.%1$s', t);
      EXECUTE format('CREATE POLICY "crm staff read %1$s" ON public.%1$s FOR SELECT TO authenticated USING (public.is_crm_staff())', t);
      -- Writes super_admin-only.
      EXECUTE format('DROP POLICY IF EXISTS "super admin write %1$s" ON public.%1$s', t);
      EXECUTE format('CREATE POLICY "super admin write %1$s" ON public.%1$s FOR ALL TO authenticated USING (public.is_super_admin()) WITH CHECK (public.is_super_admin())', t);
    END IF;
  END LOOP;
END $$;

-- ── 2. [H-08] Permissive `USING (true)` → role-check ────────────────────────
-- Bestaande policies droppen + vervangen door is_crm_staff()-check.
DO $$
DECLARE
  t text;
  perm_tables text[] := ARRAY[
    -- migratie 012 (klanten module)
    'audit_log', 'customers', 'customer_tag_definitions', 'customer_tags',
    'whatsapp_numbers', 'whatsapp_templates', 'whatsapp_messages',
    'letter_templates', 'letters', 'avg_data_requests',
    -- migratie 003 (Lisa)
    'lisa_config', 'lisa_conversations', 'lisa_messages', 'lisa_qualification',
    'lisa_feedback', 'lisa_followups', 'lisa_stats',
    -- migratie 004 (KB tags)
    'kb_tags', 'kb_item_tags',
    -- migratie 005 (Lisa settings)
    'lisa_settings',
    -- migratie 013 (customer notes)
    'customer_notes'
  ];
BEGIN
  FOREACH t IN ARRAY perm_tables LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = t) THEN
      EXECUTE format('DROP POLICY IF EXISTS "auth read %1$s" ON public.%1$s', t);
      EXECUTE format('CREATE POLICY "crm staff read %1$s" ON public.%1$s FOR SELECT TO authenticated USING (public.is_crm_staff())', t);
    END IF;
  END LOOP;
END $$;

-- role_permissions: `FOR SELECT USING (true)` (zonder TO authenticated →
-- anon-readable). Verstrengelen naar CRM-staff (rest van de mutaties blijven
-- super_admin, migratie 002 regel 196).
DROP POLICY IF EXISTS role_permissions_select_all ON public.role_permissions;
CREATE POLICY role_permissions_select_crm ON public.role_permissions
  FOR SELECT TO authenticated USING (public.is_crm_staff());

-- ── 3. [M-05] FORCE ROW LEVEL SECURITY op gevoelige tabellen ────────────────
-- Postgres-owner en SECURITY DEFINER-functies bypassen anders stil de RLS.
-- Alleen tabellen met concrete gevoelige data of write-invloed.
DO $$
DECLARE
  t text;
  force_tables text[] := ARRAY[
    'customers', 'customer_notes', 'customer_tags', 'customer_tag_definitions',
    'audit_log', 'agent_audit_log',
    'whatsapp_messages', 'whatsapp_conversations', 'whatsapp_numbers',
    'lisa_conversations', 'lisa_messages',
    'role_permissions', 'user_roles', 'profiles',
    'team_members', 'decisions',
    'learn_examples', 'email_patterns', 'email_actions', 'email_replies'
  ];
BEGIN
  FOREACH t IN ARRAY force_tables LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = t) THEN
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;

COMMIT;

-- ============================================================================
-- VERIFICATIE (draai NA COMMIT, apart)
-- ============================================================================
-- 1. Bevestig `is_crm_staff()` returnt true voor een CRM-user, false voor anon:
--    SELECT public.is_crm_staff();
--
-- 2. Elk tabel-domein test:
--    -- Als een mentor (Seppe): SELECT count(*) FROM customers; → moet werken
--    -- Als anon (uitgelogd):    SELECT count(*) FROM customers; → moet 0 zijn
--    -- Als LMS-student:         SELECT count(*) FROM customers; → moet 0 zijn
--
-- 3. RLS-status per tabel:
--    SELECT tablename, rowsecurity, forcerowsecurity FROM pg_tables
--    WHERE schemaname='public' AND tablename IN (
--      'team_members','agent_audit_log','customers','role_permissions'
--    );
--    Verwacht: rowsecurity=t, forcerowsecurity=t.
--
-- 4. Test dat service-role (supabaseAdmin) alles kan lezen (incasso-zone,
--    admin-endpoints): via een super_admin login, open Wanbetalers-module in
--    v1 → moet gewoon werken (service-role bypasst RLS).
--
-- ============================================================================
-- ROLLBACK (draai in aparte transactie als er iets breekt)
-- ============================================================================
-- BEGIN;
-- -- 1. Zet USING (true) terug op de permissive-tables:
-- DO $$
-- DECLARE
--   t text;
--   perm_tables text[] := ARRAY[
--     'audit_log','customers','customer_tag_definitions','customer_tags',
--     'whatsapp_numbers','whatsapp_templates','whatsapp_messages',
--     'letter_templates','letters','avg_data_requests',
--     'lisa_config','lisa_conversations','lisa_messages','lisa_qualification',
--     'lisa_feedback','lisa_followups','lisa_stats',
--     'kb_tags','kb_item_tags','lisa_settings','customer_notes'
--   ];
-- BEGIN
--   FOREACH t IN ARRAY perm_tables LOOP
--     EXECUTE format('DROP POLICY IF EXISTS "crm staff read %1$s" ON public.%1$s', t);
--     EXECUTE format('CREATE POLICY "auth read %1$s" ON public.%1$s FOR SELECT TO authenticated USING (true)', t);
--   END LOOP;
-- END $$;
-- -- 2. role_permissions terug:
-- DROP POLICY IF EXISTS role_permissions_select_crm ON public.role_permissions;
-- CREATE POLICY role_permissions_select_all ON public.role_permissions FOR SELECT USING (true);
-- -- 3. RLS uit op de H-07-tables (voorzichtig — dat maakt ze open weer):
-- DO $$
-- DECLARE
--   t text;
--   read_tables text[] := ARRAY['team_members','decisions','agent_audit_log',
--     'learn_examples','email_patterns','kennisbank_items','email_actions',
--     'email_replies','backfill_body_progress'];
-- BEGIN
--   FOREACH t IN ARRAY read_tables LOOP
--     EXECUTE format('DROP POLICY IF EXISTS "crm staff read %1$s" ON public.%1$s', t);
--     EXECUTE format('DROP POLICY IF EXISTS "super admin write %1$s" ON public.%1$s', t);
--     EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
--   END LOOP;
-- END $$;
-- -- 4. FORCE RLS uit:
-- DO $$
-- DECLARE
--   t text;
--   force_tables text[] := ARRAY['customers','customer_notes','customer_tags',
--     'customer_tag_definitions','audit_log','agent_audit_log',
--     'whatsapp_messages','whatsapp_conversations','whatsapp_numbers',
--     'lisa_conversations','lisa_messages','role_permissions','user_roles',
--     'profiles','team_members','decisions','learn_examples','email_patterns',
--     'email_actions','email_replies'];
-- BEGIN
--   FOREACH t IN ARRAY force_tables LOOP
--     EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t);
--   END LOOP;
-- END $$;
-- -- 5. helper-fn:
-- DROP FUNCTION IF EXISTS public.is_crm_staff();
-- COMMIT;
-- ============================================================================
