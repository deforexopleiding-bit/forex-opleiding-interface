-- ============================================================================
-- Finance 2B: permissions voor afletteren (registerPayment) + terugdraaien (removePayments)
-- Datum: 2026-06-04
-- Branch: feat/finance-2b-register-payment
--
-- Twee nieuwe feature-keys default toekennen aan manager + admin (zelfde aanpak als
-- fase-1 / 2026-06-02-sales-reports-permission.sql). super_admin krijgt alles
-- automatisch via user_has_permission() (geen row nodig). Overige rollen: NIETS by
-- default (admin kan toekennen via de rechten-matrix). Idempotent (NOT EXISTS).
-- ============================================================================

BEGIN;

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT r, k, true
FROM (VALUES ('manager'), ('admin')) AS roles(r)
CROSS JOIN (VALUES
  ('finance.invoice.payment.register'),
  ('finance.invoice.payment.remove')
) AS keys(k)
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_permissions rp
  WHERE rp.role = roles.r AND rp.feature_key = keys.k
);

COMMIT;

-- Verificatie:
--   SELECT role, feature_key, allowed FROM public.role_permissions
--   WHERE feature_key IN ('finance.invoice.payment.register','finance.invoice.payment.remove')
--   ORDER BY feature_key, role;
--
-- ROLLBACK:
--   DELETE FROM public.role_permissions
--   WHERE feature_key IN ('finance.invoice.payment.register','finance.invoice.payment.remove');
