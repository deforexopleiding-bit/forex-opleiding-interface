-- ============================================================================
-- Uitgaven-analyse (PR 1b) — role-grants voor de 2 nieuwe permission-keys
-- Datum: 2026-07-27
-- Branch: feat/finance-expenses-pr1b-ui
--
-- Zonder deze grants krijg je 403 op /api/finance-expenses-* (view+edit) en
-- op /api/finance-bank-paypal-upload (edit). Draai VÓÓR of DIRECT NA de merge
-- zodat manager/admin de tab kunnen openen en de PayPal-import kunnen doen.
--
-- Keys (staan al in modules/admin.html PERMISSION_CATALOG uit PR 1a):
--   finance.expenses.view           — Uitgaven-tab openen + lijsten lezen
--   finance.expenses.category.edit  — PayPal-upload + categoriseren + rules
--
-- super_admin heeft * (wildcard) en heeft ze automatisch — geen grant nodig.
-- Idempotent via NOT EXISTS — herhaald draaien is veilig.
--
-- Rol-toewijzing:
--   admin   → view + edit  (finance-eindverantwoordelijken)
--   manager → view + edit  (Jeffrey's rol — moet importeren + categoriseren)
--
-- sales / mentor / administratie / viewer krijgen géén automatische grant.
-- Wil je iemand anders er ook bij? Voeg 'em later toe via dezelfde patroon.
-- ============================================================================

BEGIN;

-- ── admin ────────────────────────────────────────────────────────────────
INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'admin', 'finance.expenses.view', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_permissions rp
  WHERE rp.role = 'admin' AND rp.feature_key = 'finance.expenses.view'
);

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'admin', 'finance.expenses.category.edit', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_permissions rp
  WHERE rp.role = 'admin' AND rp.feature_key = 'finance.expenses.category.edit'
);

-- ── manager ──────────────────────────────────────────────────────────────
INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'manager', 'finance.expenses.view', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_permissions rp
  WHERE rp.role = 'manager' AND rp.feature_key = 'finance.expenses.view'
);

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'manager', 'finance.expenses.category.edit', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_permissions rp
  WHERE rp.role = 'manager' AND rp.feature_key = 'finance.expenses.category.edit'
);

COMMIT;

-- ROLLBACK (indien nodig):
-- DELETE FROM public.role_permissions
-- WHERE role IN ('admin','manager')
--   AND feature_key IN ('finance.expenses.view','finance.expenses.category.edit');
