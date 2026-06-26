-- ──────────────────────────────────────────────────────────────────────────────
-- Migratie 015: per-tab RBAC voor de Sales-module + mentor klant-openen
-- ──────────────────────────────────────────────────────────────────────────────
-- Doel: de 7 sales-tabs (Dashboard / Klanten / Offertes / Abonnementen /
-- Retentie / Aanbod / Rapporten) krijgen elk een eigen feature_key zodat de
-- admin-RBAC-editor ze per rol kan toggelen. Mentor krijgt daarbij toegang tot
-- de Klanten-module zodat klant-openen werkt vanuit aanwezige/onboarding.
--
-- super_admin is bewust niet meegenomen — heeft '*' via user_has_permission
-- en bypasst alle role_permissions-checks.
--
-- Idempotent: ON CONFLICT (role, feature_key) DO UPDATE SET allowed.
-- Veilig om vaker te draaien; bij eerdere afwijkende waarde wordt
-- gerectificeerd naar het hier vastgelegde recht.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

INSERT INTO public.role_permissions (role, feature_key, allowed) VALUES
  -- ── admin: volledige sales-tab-toegang ──────────────────────────────────
  ('admin', 'sales.tab.dashboard',     true),
  ('admin', 'sales.tab.customers',     true),
  ('admin', 'sales.tab.quotations',    true),
  ('admin', 'sales.tab.subscriptions', true),
  ('admin', 'sales.tab.retentie',      true),
  ('admin', 'sales.tab.aanbod',        true),
  ('admin', 'sales.tab.reports',       true),

  -- ── manager: volledige sales-tab-toegang ────────────────────────────────
  ('manager', 'sales.tab.dashboard',     true),
  ('manager', 'sales.tab.customers',     true),
  ('manager', 'sales.tab.quotations',    true),
  ('manager', 'sales.tab.subscriptions', true),
  ('manager', 'sales.tab.retentie',      true),
  ('manager', 'sales.tab.aanbod',        true),
  ('manager', 'sales.tab.reports',       true),

  -- ── sales: volledige sales-tab-toegang ──────────────────────────────────
  ('sales', 'sales.tab.dashboard',     true),
  ('sales', 'sales.tab.customers',     true),
  ('sales', 'sales.tab.quotations',    true),
  ('sales', 'sales.tab.subscriptions', true),
  ('sales', 'sales.tab.retentie',      true),
  ('sales', 'sales.tab.aanbod',        true),
  ('sales', 'sales.tab.reports',       true),

  -- ── mentor: alleen klanten + offertes binnen de sales-module ────────────
  --   + customer.module.access voor het openen van de Klanten-module zelf
  --   (klant-openen vanuit aanwezige / onboarding-flow). Andere sales-tabs
  --   blijven verborgen.
  ('mentor', 'sales.tab.customers',  true),
  ('mentor', 'sales.tab.quotations', true),
  ('mentor', 'customer.module.access', true)
ON CONFLICT (role, feature_key) DO UPDATE
  SET allowed = EXCLUDED.allowed;

COMMIT;

-- ──────────────────────────────────────────────────────────────────────────────
-- Overige rollen (super_admin / marketing / administratie / viewer): bewust GEEN
-- sales-tab-grants. super_admin heeft '*' (bypass); marketing / administratie /
-- viewer zien sales.html sowieso niet (geen sales.module.access).
-- ──────────────────────────────────────────────────────────────────────────────

-- Rollback (handmatig, defensief):
-- DELETE FROM public.role_permissions
--  WHERE feature_key IN (
--    'sales.tab.dashboard','sales.tab.customers','sales.tab.quotations',
--    'sales.tab.subscriptions','sales.tab.retentie','sales.tab.aanbod',
--    'sales.tab.reports'
--  )
--    AND role IN ('admin','manager','sales','mentor');
-- (customer.module.access voor mentor NIET zomaar terugdraaien — kan ook door
--  andere migraties/handmatige grants geraakt zijn.)
