-- ============================================================================
-- Finance 2C write-laag: 4 nieuwe permissions (send/update/credit/create)
-- Datum: 2026-06-05
-- Branch: feat/finance-2c
-- Idempotent (NOT EXISTS); manager + admin krijgen rechten by default
-- (super_admin auto via user_has_permission RPC).
-- ============================================================================

BEGIN;

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT r, k, true
FROM (VALUES ('manager'), ('admin')) AS roles(r)
CROSS JOIN (VALUES
  ('finance.invoice.send'),
  ('finance.invoice.update'),
  ('finance.invoice.credit'),
  ('finance.invoice.create')
) AS keys(k)
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_permissions rp
  WHERE rp.role = roles.r AND rp.feature_key = keys.k
);

COMMIT;

-- Verificatie:
--   SELECT role, feature_key, allowed FROM role_permissions
--   WHERE feature_key LIKE 'finance.invoice.%' AND feature_key IN
--     ('finance.invoice.send','finance.invoice.update','finance.invoice.credit','finance.invoice.create')
--   ORDER BY feature_key, role;
