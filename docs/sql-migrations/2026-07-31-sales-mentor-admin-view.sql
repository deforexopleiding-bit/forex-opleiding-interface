-- ============================================================================
-- Sales-rol krijgt permissie 'mentor.admin.view'
-- Datum: 2026-07-31
--
-- Reden: vervolg op #1019. Dave (sales) heeft onboarding.assign_mentor,
-- maar de mentor-dropdown in het onboarding-overzicht bailt op de tweede
-- AND-voorwaarde in modules/shared/onboarding-overzicht.js:481:
--
--   if (!_canAssign || _mentorsBlocked) return '—';
--
-- _mentorsBlocked wordt true wanneer /api/mentor-admin-list een 403 geeft
-- (line 1977). Dat endpoint gate't op 'mentor.admin.view'. Zonder deze
-- grant blijft de dropdown verborgen ook al staat onboarding.assign_mentor
-- op true. Super_admin omzeilt via de '*'-bypass en ziet 'em daarom wel.
--
-- Scope-check: 'mentor.admin.view' wordt gecheckt in 4 endpoints:
--   * mentor-admin-list.js       — de mentor-lijst zelf (dit is nodig)
--   * mentor-bonus-overview.js   — dual-gate (?mentor_user_id=… → admin-pad)
--   * mentor-coaching-earnings.js — dual-gate (idem)
--   * mentor-my-calendar.js       — dual-gate (idem)
-- De laatste 3 zijn read-only admin-views van mentor-verdiensten/agenda's.
-- Sales krijgt hiermee dus read-access op die overzichten (geen mutaties).
-- Acceptabel voor de sales-workflow (context bij klant-gesprek).
--
-- Constraint-agnostisch (NOT EXISTS) zodat 'ie idempotent is. Zelfde patroon
-- als 2026-07-31-sales-onboarding-assign-mentor.sql.
-- ============================================================================

BEGIN;

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'sales', 'mentor.admin.view', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_permissions rp
  WHERE rp.role = 'sales' AND rp.feature_key = 'mentor.admin.view'
);

COMMIT;

-- ROLLBACK
-- DELETE FROM public.role_permissions
-- WHERE role = 'sales' AND feature_key = 'mentor.admin.view';
