-- 2026-09-15 · profiles.active_role — weergave-switch voor multi-rol-gebruikers
--
-- CONTEXT
-- Eén gebruiker kan meerdere rollen hebben (user_roles, N:M). Permissies blijven
-- de UNION over al zijn rollen (user_has_permission ONGEWIJZIGD). Deze kolom
-- bepaalt alléén de WEERGAVE: in welke rol de gebruiker nú acteert (CRM-landing +
-- de rol die api/lms-whoami aan de externe LMS teruggeeft).
--
--   active_role  text NULL  — de gekozen actieve rol. NULL = default (val terug
--                             op profiles.role = de hoogste rol). Server-side
--                             gevalideerd: mag alleen een rol zijn die de user
--                             ook echt in user_roles heeft (api/role-switch.js),
--                             en wordt bij het uitlezen genegeerd als de rol niet
--                             (meer) in user_roles zit.
--
-- Raakt alleen public.profiles (één kolom). Geen data-migratie, geen backfill:
-- bestaande rijen krijgen active_role = NULL ⇒ gedrag exact als vandaag.
-- Idempotent: ADD COLUMN IF NOT EXISTS. Veilig om opnieuw te draaien.

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS active_role text;

-- CHECK op dezelfde 9 rolwaarden als VALID_ROLES (api/admin-users.js) — NULL is
-- toegestaan (= default). Los toegevoegd zodat de ADD COLUMN idempotent blijft.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_active_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_active_role_check
  CHECK (active_role IS NULL OR active_role IN (
    'super_admin', 'admin', 'manager', 'sales', 'mentor',
    'marketing', 'administratie', 'appointmentsetter', 'viewer'
  ));

COMMENT ON COLUMN public.profiles.active_role IS
  'Weergave-switch: de rol waarin de gebruiker nu acteert (CRM-landing + lms-whoami). NULL = default (hoogste rol). Alleen geldig als de rol ook in user_roles staat; permissies blijven de union en zijn hier NIET van afhankelijk.';

COMMIT;

-- PostgREST/Supabase de nieuwe kolom laten oppikken (schema-cache herladen).
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- VERIFICATIE (draai NA COMMIT)
-- ============================================================================
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='profiles' AND column_name='active_role';
--   Verwacht: 1 rij (active_role, text, YES).
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
--   ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_active_role_check;
--   ALTER TABLE public.profiles DROP COLUMN IF EXISTS active_role;
--   NOTIFY pgrst, 'reload schema';
-- ============================================================================
