-- ============================================================================
-- Migratie 043: Klanten-module toegang voor rol `mentor`
-- Datum: 2026-08-26
-- Doel: mentoren mogen de Klanten-module openen en de volledige klant-lijst
--       zien. GEEN incasso-/finance-tabs (facturen/creditnotas/wanbetalers)
--       en GEEN audit-tab — die zijn client-side gated via TAB_PERM_KEYS
--       (customer.widget.finance.view / customer.audit.view) en worden niet
--       aan `mentor` gegrant. Blast-radius: alle mentoren.
--
-- Scope:
--   - Alleen `customer.module.access` — module-toegang + volledige lees-lijst
--     via /api/customers (die `verifyAdmin` OR `customer.module.access`
--     accepteert, sinds batch-1).
--   - Writes (POST/PATCH customers, archive, tags, notes, avg-export/anonymize)
--     blijven super_admin/admin-only via bestaande gates. Geen wijziging.
--
-- Idempotent: ON CONFLICT (role, feature_key) DO UPDATE SET allowed = true
-- (fix voor DO NOTHING dat een bestaande `allowed=false` zou laten staan).
-- ============================================================================

BEGIN;

INSERT INTO public.role_permissions (role, feature_key, allowed) VALUES
  ('mentor', 'customer.module.access', true)
ON CONFLICT (role, feature_key) DO UPDATE SET allowed = EXCLUDED.allowed;

COMMIT;

-- ============================================================================
-- VERIFICATIE (draai na COMMIT)
-- ============================================================================
-- 1. Grant staat:
--    SELECT role, feature_key, allowed
--      FROM public.role_permissions
--     WHERE feature_key = 'customer.module.access'
--     ORDER BY role;
--    Verwacht: manager, mentor, sales — allen allowed=true.
--
-- 2. RPC-check voor een concrete mentor (Seppe of Chesney):
--    SELECT public.user_has_permission('<MENTOR_USER_ID>'::uuid, 'customer.module.access');
--    Verwacht: true.
--
-- 3. Snelle sanity dat mentors GEEN finance/audit-widget-keys hebben:
--    SELECT role, feature_key FROM public.role_permissions
--     WHERE role = 'mentor'
--       AND feature_key IN ('customer.widget.finance.view','customer.audit.view');
--    Verwacht: 0 rijen.
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- BEGIN;
-- UPDATE public.role_permissions
--    SET allowed = false
--  WHERE role = 'mentor' AND feature_key = 'customer.module.access';
-- -- Of definitief:
-- -- DELETE FROM public.role_permissions
-- --  WHERE role = 'mentor' AND feature_key = 'customer.module.access';
-- COMMIT;
-- ============================================================================
