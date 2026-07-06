-- ============================================================================
-- Sales-rol krijgt permissie 'onboarding.admin'
-- Datum: 2026-07-06
--
-- Reden: Dave (sales) moet de Onboarding-hub kunnen zien en openen om
-- na-verkoop-onboardings af te ronden. sidebar.js gate't de Onboarding-
-- entry én de hub-pagina op deze feature-key (regel ~599/659). Zonder
-- de row blijft de link verborgen en geeft de pagina 403.
--
-- Constraint-agnostisch (NOT EXISTS) zodat 'ie idempotent is en werkt
-- ongeacht unique-keys. Zelfde patroon als 2026-06-02-sales-reports-
-- permission.sql.
--
-- super_admin/admin/manager krijgen deze permissie al elders (of via
-- user_has_permission() default-grant); hier alleen sales.
-- ============================================================================

BEGIN;

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'sales', 'onboarding.admin', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_permissions rp
  WHERE rp.role = 'sales' AND rp.feature_key = 'onboarding.admin'
);

COMMIT;

-- ROLLBACK
-- DELETE FROM public.role_permissions
-- WHERE role = 'sales' AND feature_key = 'onboarding.admin';
