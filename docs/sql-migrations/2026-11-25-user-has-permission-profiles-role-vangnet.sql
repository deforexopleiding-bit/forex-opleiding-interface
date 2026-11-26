-- ============================================================================
-- OPTIONEEL / LOS VOORSTEL — user_has_permission: profiles.role als drift-vangnet
-- Datum: 2026-11-25
-- Handmatig te draaien (niet vereist voor de code-fix in api/admin-users.js).
--
-- WAAROM
-- De permission-functie user_has_permission (migratie 002) leest de effectieve
-- rollen UITSLUITEND uit user_roles. Raakt user_roles uit sync met de scalaire
-- profiles.role (rol-drift), dan krijgt een gebruiker 0 permissies, ook al toont
-- de UI hem als sales/mentor. Dat was de oorzaak van de offerte-wizard-403.
--
-- De code-fix (api/admin-users.js) voorkomt dat de drift nog ontstaat. Deze
-- migratie is een extra VANGNET: ze laat user_has_permission OOK de scalaire
-- profiles.role mee-unionen, exact zoals has_any_role dat al defensief doet
-- (migratie 002). Zo blijft het stelsel werken zolang er ergens nog historische
-- drift in de data zit, zonder op de data-repair te hoeven wachten.
--
-- VEILIGHEID
--   · PUUR ADDITIEF: er komt alleen een extra OR-tak bij. De functie kan hierdoor
--     nooit MINDER toestaan dan voorheen — bestaande grants (admin/manager/sales/
--     super_admin) blijven één-op-één gelden. Geen enkele grant wordt gewijzigd.
--   · is_active-gate BLIJFT: de eerste EXISTS op profiles (is_active = true) staat
--     ongewijzigd vóór de hele rechten-OR, dus een soft-deleted/gedeactiveerde
--     user (is_active = false) krijgt nog steeds NIETS — ook niet via profiles.role.
--   · role_permissions blijft de enige bron van wat een rol mag; we voegen alleen
--     een tweede manier toe om de ROL van de user te bepalen (user_roles OF
--     profiles.role), identiek aan has_any_role.
--   · CREATE OR REPLACE → idempotent. Herhaald draaien is veilig.
--
-- Terugdraaien = het ORIGINEEL uit migratie 002 opnieuw plaatsen (zie ROLLBACK).
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.user_has_permission(user_uuid uuid, fkey text)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE
AS $$
  SELECT
    EXISTS (SELECT 1 FROM public.profiles WHERE id = user_uuid AND is_active = true)
    AND (
      -- (1) Effectieve rollen uit user_roles × role_permissions (ongewijzigd).
      EXISTS (
        SELECT 1
        FROM public.user_roles ur
        JOIN public.role_permissions rp ON rp.role = ur.role
        WHERE ur.user_id = user_uuid
          AND rp.feature_key = fkey
          AND rp.allowed = true
      )
      -- (2) VANGNET: scalaire profiles.role × role_permissions. Additief, net als
      --     has_any_role. Vangt rol-drift (rol staat alleen in profiles.role) op.
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        JOIN public.role_permissions rp ON rp.role = p.role
        WHERE p.id = user_uuid
          AND rp.feature_key = fkey
          AND rp.allowed = true
      )
      -- (3) super_admin = alles, via user_roles OF scalaire profiles.role.
      OR EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = user_uuid AND role = 'super_admin'
      )
      OR EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = user_uuid AND role = 'super_admin'
      )
    );
$$;

COMMIT;

-- ============================================================================
-- VERIFICATIE (draai NA COMMIT)
-- ============================================================================
-- 1. Een actieve sales/mentor die (door drift) GEEN user_roles-grant had, moet
--    nu wel true geven voor een sales-feature:
--      SELECT public.user_has_permission('<user-id>', 'sales.deal.create');
--    Verwacht: true (mits profiles.role of user_roles een rol met die grant heeft).
--
-- 2. Een gedeactiveerde user (is_active = false) moet NIETS mogen:
--      SELECT public.user_has_permission('<inactieve-user-id>', 'sales.deal.create');
--    Verwacht: false.
--
-- ============================================================================
-- ROLLBACK — herstel de originele functie uit migratie 002
-- ============================================================================
-- BEGIN;
-- CREATE OR REPLACE FUNCTION public.user_has_permission(user_uuid uuid, fkey text)
-- RETURNS boolean
-- LANGUAGE sql SECURITY DEFINER STABLE
-- AS $$
--   SELECT
--     EXISTS (SELECT 1 FROM public.profiles WHERE id = user_uuid AND is_active = true)
--     AND (
--       EXISTS (
--         SELECT 1
--         FROM public.user_roles ur
--         JOIN public.role_permissions rp ON rp.role = ur.role
--         WHERE ur.user_id = user_uuid
--           AND rp.feature_key = fkey
--           AND rp.allowed = true
--       )
--       OR EXISTS (
--         SELECT 1 FROM public.user_roles
--         WHERE user_id = user_uuid AND role = 'super_admin'
--       )
--     );
-- $$;
-- COMMIT;
-- ============================================================================
