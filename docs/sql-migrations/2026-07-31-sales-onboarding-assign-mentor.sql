-- ============================================================================
-- Sales-rol krijgt permissie 'onboarding.assign_mentor'
-- Datum: 2026-07-31
--
-- Reden: Dave (sales) moet studenten aan mentoren kunnen koppelen vanuit
-- het onboarding-overzicht (hub / admin / students-overview). De UI-dropdown
-- + het endpoint /api/onboarding-assign-mentor bestaan al; ze zijn RBAC-gate't
-- op 'onboarding.assign_mentor'. Zonder deze row blijft de dropdown verborgen
-- (canSync() → false) en geeft het endpoint 403.
--
-- Scope-check: 'onboarding.assign_mentor' geeft ALLEEN het recht om de
-- mentor_user_id op onboardings te zetten/ontkoppelen (en de bijbehorende
-- bubble-sync + notificaties). Geen andere endpoints kijken naar deze key.
-- Sales krijgt hiermee dus niks anders extra dan mentor-toewijzing.
--
-- Constraint-agnostisch (NOT EXISTS) zodat 'ie idempotent is en werkt
-- ongeacht unique-keys. Zelfde patroon als 2026-07-06-sales-onboarding-
-- admin-permission.sql (die de hub-zichtbaarheid gaf).
--
-- super_admin/admin/manager krijgen deze permissie al elders (of via
-- user_has_permission() default-grant); hier alleen sales.
-- ============================================================================

BEGIN;

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'sales', 'onboarding.assign_mentor', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_permissions rp
  WHERE rp.role = 'sales' AND rp.feature_key = 'onboarding.assign_mentor'
);

COMMIT;

-- ROLLBACK
-- DELETE FROM public.role_permissions
-- WHERE role = 'sales' AND feature_key = 'onboarding.assign_mentor';
