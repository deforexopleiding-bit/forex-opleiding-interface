-- ============================================================================
-- Migratie 041: RLS hardening — [H-07 + H-08 + M-05]
-- Datum: 2026-08-25
--
-- CONTEXT (dubbelcheck vóór uitrol, bevestigd):
--   * Alle incasso/finance/admin-endpoints (api/*dunning*, api/*arrangement*,
--     api/pending-action*, api/customer*, admin-*) gebruiken supabaseAdmin
--     (service-role) → RLS-BYPASS → onaangeroerd.
--   * ~30+ createUserClient (JWT-scoped) endpoints raken deze tabellen, ALLE
--     via Bearer + CRM-staff-gate → is_crm_staff() laat ze door.
--   * Client-side calls op deze tabellen (grep modules/):
--       - admin.html:1352,1466  → role_permissions (super_admin panel)
--       - events.html:4812      → customers (CRM-staff)
--       - finance.html:8536-62  → whatsapp_*, customers (INCASSO-adjacent, CRM-staff)
--       - instellingen-v2.js:2204,4607,4725 → agent_audit_log, role_permissions
--       - modules/shared/permissions.js:70 → role_permissions (RBAC-bootstrap
--         voor ELKE ingelogde CRM-staff → moet werken)
--   * RBAC-bootstrap-check: permissions.js draait ALLEEN op CRM-pagina's
--     (viewer/student gaan naar LMS via crm-guard). is_crm_staff() = true
--     voor die users → role_permissions.select werkt → bootstrap unaffected.
--     user_roles heeft al `user_roles_select_own` policy (migratie 002) →
--     eigen rijen leesbaar los van deze migratie. profiles-lookup binnen
--     is_crm_staff() bypasst RLS via SECURITY DEFINER → geen kip-en-ei.
--
-- WIJZIGINGEN:
--   [H-07] Enable RLS + policies op 9 tabellen die 'm nu missen.
--   [H-08] Vervang permissive `USING (true)` door `USING (is_crm_staff())`
--          op 20+ tabellen. role_permissions FOR SELECT was zelfs
--          anon-readable (geen TO authenticated) → nu CRM-staff.
--   [M-05] FORCE ROW LEVEL SECURITY op 19 gevoelige tabellen zodat
--          table-owner en SECURITY DEFINER-functies niet stil bypassen.
--
-- ROLLBACK: onderaan als plak-blok.
-- ============================================================================

BEGIN;

-- ── 0. Helper-functie: is_crm_staff() ──────────────────────────────────────
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

-- ── 1. [H-07] Tabellen ZONDER RLS → aanzetten + policies ────────────────────
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
      EXECUTE format('DROP POLICY IF EXISTS "crm staff read %1$s" ON public.%1$s', t);
      EXECUTE format('CREATE POLICY "crm staff read %1$s" ON public.%1$s FOR SELECT TO authenticated USING (public.is_crm_staff())', t);
      EXECUTE format('DROP POLICY IF EXISTS "super admin write %1$s" ON public.%1$s', t);
      EXECUTE format('CREATE POLICY "super admin write %1$s" ON public.%1$s FOR ALL TO authenticated USING (public.is_super_admin()) WITH CHECK (public.is_super_admin())', t);
    END IF;
  END LOOP;
END $$;

-- ── 2. [H-08] Permissive `USING (true)` → is_crm_staff() ────────────────────
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

-- role_permissions: [H-08] was `FOR SELECT USING (true)` (anon-readable!).
-- Naar CRM-staff. Zoals dubbelcheck: RBAC-bootstrap in permissions.js:70
-- draait alleen voor ingelogde CRM-staff, dus dit blijft werken.
DROP POLICY IF EXISTS role_permissions_select_all ON public.role_permissions;
CREATE POLICY role_permissions_select_crm ON public.role_permissions
  FOR SELECT TO authenticated USING (public.is_crm_staff());

-- ── 3. [M-05] FORCE ROW LEVEL SECURITY op gevoelige tabellen ────────────────
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
