-- ============================================================
-- RBAC Foundation — De Forex Opleiding
-- Uitvoeren in Supabase SQL Editor (één keer). Re-runnable (idempotent).
-- Datum: 2026-05-23
--
-- Voegt toe: 'marketing' rol, user_roles (multi-role N:M, nieuwe bron van
-- waarheid), role_permissions (feature_key per rol), helper-functies en RLS.
-- Backward compatible: profiles.role blijft bestaan als "primary role".
-- ============================================================

-- ── 1) 'marketing' rol toevoegen aan de profiles CHECK ────────────────────────
-- (constraint is ooit inline aangemaakt → auto-naam profiles_role_check)
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN (
    'super_admin', 'admin', 'manager', 'sales', 'mentor',
    'administratie', 'marketing', 'viewer'
  ));


-- ── 2) user_roles — multi-role per user (N:M, nieuwe bron van waarheid) ────────
CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN (
                'super_admin', 'admin', 'manager', 'sales', 'mentor',
                'administratie', 'marketing', 'viewer'
              )),
  assigned_at timestamptz DEFAULT now(),
  assigned_by uuid REFERENCES auth.users(id),
  PRIMARY KEY (user_id, role)
);


-- ── 3) role_permissions — feature_key per rol (bewust leeg gelaten) ────────────
CREATE TABLE IF NOT EXISTS public.role_permissions (
  role        text NOT NULL CHECK (role IN (
                'super_admin', 'admin', 'manager', 'sales', 'mentor',
                'administratie', 'marketing', 'viewer'
              )),
  feature_key text NOT NULL,
  allowed     boolean DEFAULT false,
  updated_at  timestamptz DEFAULT now(),
  updated_by  uuid REFERENCES auth.users(id),
  PRIMARY KEY (role, feature_key)
);


-- ── 4) Backfill: bestaande profiles.role → user_roles ─────────────────────────
-- Iedere user krijgt zijn huidige (primary) rol als eerste user_roles-rij.
INSERT INTO public.user_roles (user_id, role, assigned_at)
SELECT id, role, created_at FROM public.profiles
ON CONFLICT (user_id, role) DO NOTHING;


-- ── 5) Trigger bijwerken: nieuwe users ook in user_roles spiegelen ────────────
-- Zonder dit zou een nieuwe signup wél een profiles-rij maar géén user_roles-rij
-- krijgen, waardoor role-checks (has_any_role) zouden falen.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
DECLARE
  v_role text := COALESCE(NEW.raw_user_meta_data->>'role', 'viewer');
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    v_role
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, v_role)
  ON CONFLICT (user_id, role) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ── 6) Helpers ────────────────────────────────────────────────────────────────

-- Alle rollen van een user (union).
CREATE OR REPLACE FUNCTION public.get_user_all_roles(user_uuid uuid)
RETURNS text[]
LANGUAGE sql SECURITY DEFINER STABLE
AS $$
  SELECT COALESCE(array_agg(role), ARRAY[]::text[])
  FROM public.user_roles
  WHERE user_id = user_uuid;
$$;

-- Is de huidige user super_admin? SECURITY DEFINER → draait als owner en
-- omzeilt RLS, zodat policies die dit aanroepen GEEN recursie veroorzaken.
-- Vereist een actief profiel.
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
    WHERE ur.user_id = auth.uid()
      AND ur.role = 'super_admin'
      AND p.is_active = true
  );
$$;

-- Heeft de huidige user toegang tot een feature_key?
-- Union over al zijn rollen → OR over role_permissions.allowed. super_admin = alles.
CREATE OR REPLACE FUNCTION public.user_has_permission(user_uuid uuid, fkey text)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE
AS $$
  SELECT
    EXISTS (SELECT 1 FROM public.profiles WHERE id = user_uuid AND is_active = true)
    AND (
      EXISTS (
        SELECT 1
        FROM public.user_roles ur
        JOIN public.role_permissions rp ON rp.role = ur.role
        WHERE ur.user_id = user_uuid
          AND rp.feature_key = fkey
          AND rp.allowed = true
      )
      OR EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = user_uuid AND role = 'super_admin'
      )
    );
$$;

-- has_any_role: zelfde signatuur (required_roles) BEHOUDEN — Postgres staat geen
-- hernoeming van parameters toe bij CREATE OR REPLACE. Defensieve union over
-- user_roles ÉN profiles.role zodat er tijdens de transitie niets breekt, met
-- behoud van de is_active-eis.
CREATE OR REPLACE FUNCTION public.has_any_role(required_roles text[])
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE
AS $$
  SELECT
    EXISTS (
      SELECT 1
      FROM public.user_roles ur
      JOIN public.profiles p ON p.id = ur.user_id
      WHERE ur.user_id = auth.uid()
        AND ur.role = ANY(required_roles)
        AND p.is_active = true
    )
    OR EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.role = ANY(required_roles)
        AND p.is_active = true
    );
$$;


-- ── 7) RLS: user_roles ────────────────────────────────────────────────────────
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_roles_select_own   ON public.user_roles;
DROP POLICY IF EXISTS user_roles_select_admin ON public.user_roles;
DROP POLICY IF EXISTS user_roles_insert_admin ON public.user_roles;
DROP POLICY IF EXISTS user_roles_delete_admin ON public.user_roles;

-- Eigen rollen lezen.
CREATE POLICY user_roles_select_own ON public.user_roles
  FOR SELECT USING (user_id = auth.uid());

-- super_admin: alle rollen lezen/toekennen/verwijderen.
-- (is_super_admin() is SECURITY DEFINER → geen RLS-recursie op user_roles)
CREATE POLICY user_roles_select_admin ON public.user_roles
  FOR SELECT USING (public.is_super_admin());

CREATE POLICY user_roles_insert_admin ON public.user_roles
  FOR INSERT WITH CHECK (public.is_super_admin());

CREATE POLICY user_roles_delete_admin ON public.user_roles
  FOR DELETE USING (public.is_super_admin());


-- ── 8) RLS: role_permissions ──────────────────────────────────────────────────
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_permissions_select_all  ON public.role_permissions;
DROP POLICY IF EXISTS role_permissions_modify_admin ON public.role_permissions;

-- Iedereen (ingelogd) mag lezen — frontend permission-check.
CREATE POLICY role_permissions_select_all ON public.role_permissions
  FOR SELECT USING (true);

-- Alleen super_admin mag wijzigen (USING + WITH CHECK voor alle commando's).
CREATE POLICY role_permissions_modify_admin ON public.role_permissions
  FOR ALL USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());


-- ── 9) Indexes ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_user_roles_user        ON public.user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_role  ON public.role_permissions(role);
CREATE INDEX IF NOT EXISTS idx_role_permissions_feat  ON public.role_permissions(feature_key);


-- ── Verificatie (handmatig draaien na uitvoeren) ──────────────────────────────
-- SELECT conname FROM pg_constraint WHERE conname = 'profiles_role_check';
-- SELECT COUNT(*) AS backfilled FROM public.user_roles;
-- SELECT routine_name FROM information_schema.routines
--   WHERE routine_schema='public'
--     AND routine_name IN ('get_user_all_roles','is_super_admin','user_has_permission','has_any_role');
-- SELECT policyname, tablename FROM pg_policies
--   WHERE tablename IN ('user_roles','role_permissions') ORDER BY tablename, policyname;
