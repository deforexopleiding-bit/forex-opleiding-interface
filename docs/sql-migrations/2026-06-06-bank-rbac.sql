-- ============================================================================
-- Finance Fase 3 — Bank-tab RBAC permission
-- Datum: 2026-06-06
-- Branch: feat/finance-3-bank-overview
--
-- Eén nieuwe permission: finance.bank.view (read-toegang Bank-tab).
-- Manager + admin krijgen 'm by default; super_admin auto via
-- user_has_permission RPC. Idempotent (NOT EXISTS).
-- ============================================================================

BEGIN;

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT r, k, true
FROM (VALUES ('manager'), ('admin')) AS roles(r)
CROSS JOIN (VALUES
  ('finance.bank.view')
) AS keys(k)
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_permissions rp
  WHERE rp.role = roles.r AND rp.feature_key = keys.k
);

COMMIT;

-- Verificatie:
--   SELECT role, feature_key, allowed FROM role_permissions
--   WHERE feature_key = 'finance.bank.view' ORDER BY role;
