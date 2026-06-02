-- ============================================================================
-- Sales Fase 4: permission sales.reports.view
-- Datum: 2026-06-02
-- Branch: feature/sales-fase-4-rapporten
--
-- Feature-key sales.reports.view default toekennen aan manager + admin.
-- super_admin krijgt alles automatisch via user_has_permission() (geen row nodig).
-- sales-rol krijgt NIETS by default (admin kan toekennen via de rechten-matrix).
-- Constraint-agnostisch (NOT EXISTS) zodat het werkt ongeacht unique-keys.
-- ============================================================================

BEGIN;

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT r, 'sales.reports.view', true
FROM (VALUES ('manager'), ('admin')) AS x(r)
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_permissions rp
  WHERE rp.role = x.r AND rp.feature_key = 'sales.reports.view'
);

COMMIT;

-- ROLLBACK
-- DELETE FROM public.role_permissions WHERE feature_key = 'sales.reports.view';
