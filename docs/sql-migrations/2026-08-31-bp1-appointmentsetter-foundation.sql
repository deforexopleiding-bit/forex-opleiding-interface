-- 2026-08-31-bp1-appointmentsetter-foundation.sql
--
-- STATUS: TER REVIEW — NIET AUTOMATISCH DRAAIEN.
-- Bouwpakket 1 (Romy als appointmentsetter) — SQL-foundation.
--
-- Wat dit doet:
--   1. Rol 'appointmentsetter' toevoegen aan profiles.role + user_roles.role
--      CHECK-constraints.
--   2. public.is_crm_staff() herdefiniëren zodat de rol als CRM-staff
--      wordt herkend (anders redirect crm-guard 'em naar het LMS).
--   3. wa_snippets-tabel + RLS + indexes (onderdeel C — gedeelde snippet-
--      bibliotheek + persoonlijke snippets per owner).
--   4. role_permissions seed voor 'appointmentsetter' — leadsonderhoud-scope
--      + snippets + meta-templates (delete blijft super_admin-only).
--   5. Ook: manager + admin krijgen de nieuwe snippets.* + meta-templates-
--      manage grants (Romy is niet de enige beheerder).
--
-- Wat dit NIET doet:
--   - JS-staff-lijst-uitbreidingen in de 3 code-files (aparte code-review).
--   - Finance-RLS-hardening (aparte volgende migratie — zie risico-rapport).
--   - Romy's Supabase-Auth-account aanmaken (handmatig via admin-panel).
--
-- Draai-volgorde:
--   1. Draai dit migratiebestand pas na review + code-deploy van BP1.
--   2. Direct daarna: kende (via admin-panel of SQL) `appointmentsetter`
--      aan Romy's user_roles-rij. Zonder migratie faalt die INSERT op
--      de CHECK-constraint.
--
-- 0 incasso-writes. Raakt geen finance-/incasso-tabellen.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════
-- 1) CHECK-constraints uitbreiden met 'appointmentsetter'
-- ═══════════════════════════════════════════════════════════════════════

-- profiles.role
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN (
    'super_admin', 'admin', 'manager', 'sales', 'mentor',
    'administratie', 'marketing', 'appointmentsetter',
    'viewer', 'student'
  ));

-- user_roles.role (idempotent — DROP + ADD)
ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_role_check;
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_role_check
  CHECK (role IN (
    'super_admin', 'admin', 'manager', 'sales', 'mentor',
    'administratie', 'marketing', 'appointmentsetter',
    'viewer', 'student'
  ));

-- role_permissions.role
ALTER TABLE public.role_permissions DROP CONSTRAINT IF EXISTS role_permissions_role_check;
ALTER TABLE public.role_permissions ADD CONSTRAINT role_permissions_role_check
  CHECK (role IN (
    'super_admin', 'admin', 'manager', 'sales', 'mentor',
    'administratie', 'marketing', 'appointmentsetter',
    'viewer', 'student'
  ));

-- ═══════════════════════════════════════════════════════════════════════
-- 2) public.is_crm_staff() herdefiniëren met appointmentsetter
-- ═══════════════════════════════════════════════════════════════════════
--
-- Deze functie wordt door crm-guard.js én door 40+ RLS-policies gebruikt
-- als CRM-staff-check. Zonder appointmentsetter erin wordt Romy na login
-- door crm-guard naar het LMS geredirect (uit hardening 041).

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
      AND role IN (
        'super_admin', 'admin', 'manager', 'sales', 'mentor',
        'marketing', 'administratie', 'appointmentsetter'
      )
  );
$$;

REVOKE ALL ON FUNCTION public.is_crm_staff() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_crm_staff() TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 3) wa_snippets — gedeelde/persoonlijke WhatsApp-snippet-bibliotheek
-- ═══════════════════════════════════════════════════════════════════════
--
-- owner_user_id = NULL → gedeelde teamsnippet (zichtbaar voor iedereen met
-- snippets.view). owner_user_id = user.id → persoonlijke snippet (alleen
-- eigenaar + admins zien 'em).
--
-- body_text mag {voornaam} / {naam} bevatten (client-side variabel-invulling
-- in de composer; onderdeel B).

CREATE TABLE IF NOT EXISTS public.wa_snippets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  titel         text NOT NULL CHECK (char_length(titel) BETWEEN 1 AND 120),
  body_text     text NOT NULL CHECK (char_length(body_text) BETWEEN 1 AND 2000),
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  sort_order    integer NOT NULL DEFAULT 100,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES auth.users(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS idx_wa_snippets_owner
  ON public.wa_snippets (owner_user_id, sort_order, titel);
CREATE INDEX IF NOT EXISTS idx_wa_snippets_shared
  ON public.wa_snippets (sort_order, titel)
  WHERE owner_user_id IS NULL;

-- Update-trigger op updated_at.
CREATE OR REPLACE FUNCTION public.wa_snippets_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_wa_snippets_touch ON public.wa_snippets;
CREATE TRIGGER trg_wa_snippets_touch
  BEFORE UPDATE ON public.wa_snippets
  FOR EACH ROW EXECUTE FUNCTION public.wa_snippets_touch_updated_at();

-- RLS: alleen CRM-staff mag lezen; muteren gebeurt uitsluitend via
-- service_role (server-endpoints), dus geen INSERT/UPDATE/DELETE-policies.
ALTER TABLE public.wa_snippets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wa_snippets_select ON public.wa_snippets;
CREATE POLICY wa_snippets_select ON public.wa_snippets
  FOR SELECT TO authenticated USING (public.is_crm_staff());

COMMENT ON TABLE public.wa_snippets IS
  'Gedeelde/persoonlijke WhatsApp-snippet-bibliotheek voor leadsonderhoud-composer. '
  'owner_user_id NULL = gedeeld; anders persoonlijk. body_text ondersteunt '
  '{voornaam}/{naam} placeholders die client-side worden ingevuld.';

-- ═══════════════════════════════════════════════════════════════════════
-- 4) role_permissions seed
-- ═══════════════════════════════════════════════════════════════════════
--
-- APPOINTMENTSETTER (Romy) — minimum voor operatie.
-- Alle grants zijn 'allowed=true'. ON CONFLICT DO NOTHING → idempotent.
--
-- Bewust NIET toegekend:
--   - Alle finance.*, sales.*, mentor.*, onboarding.*, events.*, ads.*
--   - admin.module.access, admin.joost_config
--   - customer.module.access
--   - taken.*, email.*, tickets.*, meetings.*, kennisbank.*, lisa.*, agents.*
--   - dashboard.*.view (Romy heeft geen dashboard)
--   - leads.update / leads.delete / leads.promote (BP2 fine-grained key
--     voor appointments.create.setter)

INSERT INTO public.role_permissions (role, feature_key, allowed) VALUES
  -- Kern: leadsonderhoud-scope. leads.view dekt gesprekken, template-picker,
  -- lead-detail, alle read-endpoints (bevestiging, toegang-aanvragen, etc.)
  ('appointmentsetter', 'leads.view',                    true),

  -- Snippet-bibliotheek (onderdeel C).
  ('appointmentsetter', 'snippets.view',                 true),
  ('appointmentsetter', 'snippets.manage',               true),

  -- Meta-template-beheer (onderdeel D). DELETE blijft super_admin-only
  -- via hardcoded check in api/admin-meta-templates-delete.js → geen
  -- feature_key nodig.
  ('appointmentsetter', 'admin.meta_templates.manage',   true)
ON CONFLICT (role, feature_key) DO NOTHING;

-- MANAGER — voeg nieuwe keys toe zodat Romy niet de enige beheerder is.
INSERT INTO public.role_permissions (role, feature_key, allowed) VALUES
  ('manager', 'snippets.view',                           true),
  ('manager', 'snippets.manage',                         true),
  ('manager', 'admin.meta_templates.manage',             true)
ON CONFLICT (role, feature_key) DO NOTHING;

-- ADMIN — zelfde nieuwe keys.
INSERT INTO public.role_permissions (role, feature_key, allowed) VALUES
  ('admin', 'snippets.view',                             true),
  ('admin', 'snippets.manage',                           true),
  ('admin', 'admin.meta_templates.manage',               true)
ON CONFLICT (role, feature_key) DO NOTHING;

-- super_admin: geen grants nodig (wildcard via user_has_permission).

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- POST-CHECK
-- ═══════════════════════════════════════════════════════════════════════
--
-- 1. Verifieer CHECK-constraint uitgebreid:
--    INSERT INTO public.user_roles (user_id, role)
--    VALUES ('00000000-0000-0000-0000-000000000000', 'appointmentsetter');
--    ↑ Zou moeten falen op FK, NIET op CHECK.
--
-- 2. Verifieer is_crm_staff() returnt true voor appointmentsetter-account:
--    SET request.jwt.claims TO '{"sub": "<romy-user-id>"}';
--    SELECT public.is_crm_staff();  -- verwacht: true
--
-- 3. Verifieer role_permissions seeds:
--    SELECT role, feature_key FROM public.role_permissions
--    WHERE role = 'appointmentsetter' ORDER BY feature_key;
--    -- verwacht: 4 rijen (leads.view, snippets.view, snippets.manage,
--    --                    admin.meta_templates.manage)
--
-- 4. Verifieer wa_snippets werkt end-to-end:
--    INSERT INTO public.wa_snippets (titel, body_text)
--    VALUES ('Test-snippet', 'Hoi {voornaam}, dit is een test.');
--    SELECT id, titel, owner_user_id FROM public.wa_snippets;
--
-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK (indien nodig)
-- ═══════════════════════════════════════════════════════════════════════
--
-- BEGIN;
--   DELETE FROM public.role_permissions
--     WHERE role = 'appointmentsetter'
--        OR (role IN ('manager','admin') AND feature_key IN (
--             'snippets.view', 'snippets.manage', 'admin.meta_templates.manage'
--           ));
--   DELETE FROM public.user_roles WHERE role = 'appointmentsetter';
--   UPDATE public.profiles SET role = 'viewer' WHERE role = 'appointmentsetter';
--   DROP TABLE IF EXISTS public.wa_snippets CASCADE;
--   DROP FUNCTION IF EXISTS public.wa_snippets_touch_updated_at();
--   -- Herstel is_crm_staff() naar pre-BP1 versie (uit migratie 041):
--   CREATE OR REPLACE FUNCTION public.is_crm_staff() RETURNS boolean
--     LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
--     AS $$ SELECT EXISTS (
--       SELECT 1 FROM public.profiles
--       WHERE id = auth.uid() AND is_active = true
--         AND role IN ('super_admin','admin','manager','sales','mentor','marketing','administratie')
--     ); $$;
--   ALTER TABLE public.profiles DROP CONSTRAINT profiles_role_check;
--   ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check CHECK (role IN (
--     'super_admin','admin','manager','sales','mentor','administratie','marketing','viewer','student'
--   ));
--   -- idem user_roles + role_permissions.
-- COMMIT;
