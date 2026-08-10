-- ============================================================================
-- Migratie 016: per-gebruiker permission-allowlist (user_permissions)
-- Datum: 2026-08-10
-- Branch: feat/user-permissions-allowlist
--
-- DOEL: naast het rol-gebaseerde model (role_permissions) een manier om één
-- specifieke gebruiker extra feature_keys te geven ZONDER dat andere gebruikers
-- met dezelfde rol die ook krijgen. Bedoeld voor echte uitzonderingen
-- ("geef alleen deze persoon toegang tot X"), niet als vervanging van rollen.
--
-- Model: rollen blijven de basislaag; user_permissions is een union daar
-- bovenop. Een user krijgt een feature als ZIJN ROL die heeft (role_permissions)
-- OF als er een eigen rij in user_permissions staat OF als hij super_admin is.
--
-- Deze migratie voegt GEEN concrete grants toe — alleen het mechanisme. De
-- daadwerkelijke per-persoon-grant (bv. Chesney × onboarding.admin) is een
-- aparte INSERT die na deze migratie gedraaid wordt, zodra de user-uuid bekend
-- is (zie voorbeeld onderaan).
--
-- IDEMPOTENT: CREATE TABLE IF NOT EXISTS + CREATE OR REPLACE FUNCTION +
-- DROP/CREATE POLICY. Herhaald draaien is veilig.
-- ============================================================================

BEGIN;

-- ── 1) Tabel ─────────────────────────────────────────────────────────────────
-- Sleutel (user_id, feature_key), analoog aan role_permissions (role, feature_key).
CREATE TABLE IF NOT EXISTS public.user_permissions (
  user_id     uuid    NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  feature_key text    NOT NULL,
  allowed     boolean NOT NULL DEFAULT true,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by uuid    REFERENCES public.profiles(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, feature_key)
);

COMMENT ON TABLE public.user_permissions IS
  'Per-gebruiker feature-allowlist (union bovenop role_permissions). Voor uitzonderingen op 1 persoon.';

-- ── 2) user_has_permission() uitbreiden met de user_permissions-tak ───────────
-- Identiek aan migratie 002, met één extra OR EXISTS binnen dezelfde AND — dus
-- nog steeds gegate op profiles.is_active. super_admin-bypass blijft ongemoeid.
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
        SELECT 1
        FROM public.user_permissions up
        WHERE up.user_id = user_uuid
          AND up.feature_key = fkey
          AND up.allowed = true
      )
      OR EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = user_uuid AND role = 'super_admin'
      )
    );
$$;

-- ── 3) RLS ───────────────────────────────────────────────────────────────────
-- Zelfde patroon als user_roles: eigen rijen leesbaar (frontend leest zijn eigen
-- allowlist), super_admin leest/wijzigt alles. is_super_admin() is SECURITY
-- DEFINER → geen RLS-recursie.
ALTER TABLE public.user_permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_permissions_select_own   ON public.user_permissions;
DROP POLICY IF EXISTS user_permissions_select_admin ON public.user_permissions;
DROP POLICY IF EXISTS user_permissions_modify_admin ON public.user_permissions;

CREATE POLICY user_permissions_select_own ON public.user_permissions
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY user_permissions_select_admin ON public.user_permissions
  FOR SELECT USING (public.is_super_admin());

CREATE POLICY user_permissions_modify_admin ON public.user_permissions
  FOR ALL USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

-- ── 4) Indexes ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_user_permissions_user ON public.user_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_permissions_feat ON public.user_permissions(feature_key);

COMMIT;

-- ── VOORBEELD-GRANT (los draaien, NIET onderdeel van deze migratie) ──────────
-- Zodra Chesney's profiles.id (uuid) bekend is, geef hem de volledige
-- onboarding-view (zoals super_admin) + de follow-up-module. Alleen Chesney;
-- andere mentors blijven ongemoeid.
--
-- INSERT INTO public.user_permissions (user_id, feature_key) VALUES
--   ('<CHESNEY_UUID>','onboarding.admin'),
--   ('<CHESNEY_UUID>','onboarding.assign_mentor'),
--   ('<CHESNEY_UUID>','onboarding.wizard.edit'),
--   ('<CHESNEY_UUID>','onboarding.automation.view'),
--   ('<CHESNEY_UUID>','onboarding.inbox.view'),
--   ('<CHESNEY_UUID>','onboarding.inbox.send'),
--   ('<CHESNEY_UUID>','onboarding.inbox.reply_link'),
--   ('<CHESNEY_UUID>','onboarding.mila.use'),
--   ('<CHESNEY_UUID>','followup.module.access')
-- ON CONFLICT (user_id, feature_key) DO NOTHING;

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- 1) herstel user_has_permission() naar de 002-versie (zonder user_permissions-tak)
-- 2) DROP TABLE public.user_permissions;
-- (De function-rollback = de exacte body uit migratie 002 opnieuw CREATE OR REPLACE.)
