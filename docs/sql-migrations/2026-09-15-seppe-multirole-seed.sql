-- 2026-09-15 · FASE 0 — Seppe: mentor + super_admin naast elkaar (multi-rol)
--
-- CONTEXT
-- Geeft Seppe BEIDE rollen in user_roles (de multi-rol-manier — NIET
-- set_canonical_role, die de andere rollen zou wissen). Zo blijven zijn
-- mentor-koppelingen (team_members / onboardings.mentor_user_id / event_mentors /
-- hlms_student.mentor_id) én mentor-permissies intact, náást super_admin.
-- Permissies zijn de union over user_roles; super_admin geeft sowieso alles.
--
-- profiles.role wordt op de hoogste rol gezet (super_admin) — dat is de "primaire"
-- rol voor legacy checks. De WEERGAVE regelt hij daarna zelf met de schakelknop
-- (profiles.active_role), zie de kolom-migratie 2026-09-15-profiles-active-role.sql.
--
-- Idempotent: ON CONFLICT DO NOTHING op user_roles; geen dubbele rijen bij
-- opnieuw draaien. Wist NOOIT bestaande rollen.
--
-- >>> VERVANG hieronder 'VUL_SEPPE_EMAIL_IN@…' door Seppe's echte e-mailadres <<<
--     (het adres waarmee hij in de CRM/Supabase-auth bekend is).

BEGIN;

WITH seppe AS (
  SELECT id
  FROM public.profiles
  WHERE lower(email) = lower('VUL_SEPPE_EMAIL_IN@example.com')
  LIMIT 1
)
INSERT INTO public.user_roles (user_id, role)
SELECT seppe.id, r.role
FROM seppe
CROSS JOIN (VALUES ('mentor'), ('super_admin')) AS r(role)
ON CONFLICT (user_id, role) DO NOTHING;

-- profiles.role = hoogste rol (super_admin) voor legacy requireAuth/verifyAdmin.
UPDATE public.profiles p
   SET role = 'super_admin', updated_at = now()
  FROM (SELECT id FROM public.profiles WHERE lower(email) = lower('VUL_SEPPE_EMAIL_IN@example.com') LIMIT 1) s
 WHERE p.id = s.id
   AND p.role IS DISTINCT FROM 'super_admin';

COMMIT;

-- ============================================================================
-- VERIFICATIE (draai NA COMMIT — verwacht 2 rijen: mentor + super_admin)
-- ============================================================================
--   SELECT ur.role
--     FROM public.user_roles ur
--     JOIN public.profiles p ON p.id = ur.user_id
--    WHERE lower(p.email) = lower('VUL_SEPPE_EMAIL_IN@example.com')
--    ORDER BY ur.role;
--
-- ============================================================================
-- ROLLBACK (verwijder alléén de toegevoegde mentor-rol; super_admin behouden)
-- ============================================================================
--   DELETE FROM public.user_roles ur
--    USING public.profiles p
--    WHERE ur.user_id = p.id
--      AND lower(p.email) = lower('VUL_SEPPE_EMAIL_IN@example.com')
--      AND ur.role = 'mentor';
-- ============================================================================
