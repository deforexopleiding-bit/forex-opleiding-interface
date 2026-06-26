-- ============================================================================
-- Migratie 014: RBAC role_permissions-seed voor role-based landing
-- Datum: 2026-06-26
-- Branch: feat/rbac-role-landing
--
-- DOEL: vastleggen van de role_permissions-grants die in PROD zijn gezet zodat
-- manager / sales / mentor na login op hun eigen dashboard kunnen landen.
-- De grants zelf zijn al productioneel actief (handmatig gedraaid); dit
-- bestand is puur een geschiedenis-record voor versiebeheer.
--
-- Mapping (zie modules/shared/supabase-client.js → ROLE_LANDING):
--   super_admin → /index.html                       (bypass, geen rij nodig)
--   admin       → /index.html
--   manager     → /modules/control-center.html
--   sales       → /modules/sales-dashboard.html → /modules/sales.html?tab=dashboard
--   mentor      → /modules/mentor-dashboard.html
--   marketing / administratie / viewer → /index.html (geen extra grant nodig)
--
-- IDEMPOTENT (ON CONFLICT DO NOTHING): bij herhaald draaien worden bestaande
-- grants niet overschreven, ontbrekende worden alsnog toegevoegd. Schade-vrij
-- veilig om alsnog uit te voeren als deze migratie nooit was gedraaid.
--
-- super_admin krijgt geen rij: user_has_permission() returnt true voor alles
-- bij super_admin via de explicit bypass in de RPC-helper (zie migratie 002).
-- ============================================================================

BEGIN;

-- ── Manager → /modules/control-center.html ─────────────────────────────────
--   - dashboard.module.access: zodat de Dashboard-link (default /index.html)
--     niet door applyModuleGating verborgen wordt.
--   - controlcenter.module.access: zodat de control-center-pagina (de landing
--     na login) bereikbaar is en niet door applyModuleGating geblokkeerd wordt.
INSERT INTO public.role_permissions (role, feature_key, allowed) VALUES
  ('manager', 'dashboard.module.access',     true),
  ('manager', 'controlcenter.module.access', true)
ON CONFLICT (role, feature_key) DO NOTHING;

-- ── Sales → /modules/sales-dashboard.html → /modules/sales.html?tab=dashboard ─
--   - dashboard.sales.view: zorgt dat de Dashboard-link in de sidebar werkt
--     én dat sales-dashboard.html niet als "geen toegang" blokkeert.
--   - sales.module.access: zodat de redirect-target sales.html?tab=dashboard
--     ook bereikbaar is.
INSERT INTO public.role_permissions (role, feature_key, allowed) VALUES
  ('sales', 'dashboard.sales.view', true),
  ('sales', 'sales.module.access',  true)
ON CONFLICT (role, feature_key) DO NOTHING;

-- ── Mentor → /modules/mentor-dashboard.html ────────────────────────────────
--   - dashboard.module.access: voor de generieke Dashboard-link-fallback.
--   - mentor.module.access: zodat de mentor-dashboard-pagina (landing na login)
--     niet door applyModuleGating geblokkeerd wordt.
INSERT INTO public.role_permissions (role, feature_key, allowed) VALUES
  ('mentor', 'dashboard.module.access', true),
  ('mentor', 'mentor.module.access',    true)
ON CONFLICT (role, feature_key) DO NOTHING;

COMMIT;

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- DELETE FROM public.role_permissions
-- WHERE (role, feature_key) IN (
--   ('manager', 'dashboard.module.access'),
--   ('manager', 'controlcenter.module.access'),
--   ('sales',   'dashboard.sales.view'),
--   ('sales',   'sales.module.access'),
--   ('mentor',  'dashboard.module.access'),
--   ('mentor',  'mentor.module.access')
-- );
