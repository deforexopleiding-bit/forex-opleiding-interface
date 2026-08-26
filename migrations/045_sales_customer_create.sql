-- ============================================================================
-- Migratie 045: Sales mag nieuwe klanten aanmaken
-- Datum: 2026-08-26
-- Doel: rol `sales` krijgt `customer.create` — nieuwe klanten inschrijven
--       via de Klanten-module "Nieuwe klant"-knop. Kernwerk voor sales.
--
-- Scope:
--   - Alleen `customer.create` — POST /api/customer accepteert nu
--     verifyAdmin OR requirePermission('customer.create') (sinds deze commit).
--   - Insert doet ALLEEN customers-tabel + audit. GEEN TeamLeader-sync,
--     GEEN subscription, GEEN invoice, GEEN incasso-side-effect.
--     (tlFetch elders in customer.js zit alleen in PATCH-pad, blijft admin.)
--   - Bewerken/archiveren/verwijderen/tags/notes/AVG blijven strikt
--     verifyAdmin via bestaande gates in api/customer.js POST/PATCH +
--     api/customer-*.js. Sales krijgt hier NIETS bij.
--
-- Blast-radius: alle sales-users (Dave e.a.). Bevestigd door Jeffrey.
--
-- Idempotent: ON CONFLICT (role, feature_key) DO UPDATE SET allowed = true
-- (fix voor DO NOTHING dat een bestaande `allowed=false` zou laten staan).
-- ============================================================================

BEGIN;

INSERT INTO public.role_permissions (role, feature_key, allowed) VALUES
  ('sales', 'customer.create', true)
ON CONFLICT (role, feature_key) DO UPDATE SET allowed = EXCLUDED.allowed;

COMMIT;

-- ============================================================================
-- VERIFICATIE (draai NA COMMIT)
-- ============================================================================
-- 1. Grant staat:
--    SELECT role, feature_key, allowed
--      FROM public.role_permissions
--     WHERE feature_key = 'customer.create'
--     ORDER BY role;
--    Verwacht: sales — allowed=true.
--
-- 2. Sanity dat sales NIET ineens ook edit/archive/hard_delete heeft:
--    SELECT role, feature_key FROM public.role_permissions
--     WHERE role = 'sales'
--       AND feature_key IN ('customer.edit','customer.archive','customer.hard_delete','customer.tag_manage');
--    Verwacht: 0 rijen.
--
-- 3. RPC-check voor Dave (of andere sales-user):
--    SELECT public.user_has_permission('<DAVE_USER_ID>'::uuid, 'customer.create');
--    Verwacht: true.
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- BEGIN;
-- UPDATE public.role_permissions
--    SET allowed = false
--  WHERE role = 'sales' AND feature_key = 'customer.create';
-- -- Of definitief:
-- -- DELETE FROM public.role_permissions
-- --  WHERE role = 'sales' AND feature_key = 'customer.create';
-- COMMIT;
-- ============================================================================
