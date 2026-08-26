-- ============================================================================
-- Migratie 045: Sales én mentor mogen nieuwe klanten aanmaken
-- Datum: 2026-08-26
-- Doel: rollen `sales` en `mentor` krijgen `customer.create` — nieuwe klanten
--       inschrijven via de Klanten-module "Nieuwe klant"-knop. Kernwerk voor
--       sales; mentoren mogen óók klanten inschrijven (Chesney/Seppe e.a.).
--
-- Scope:
--   - Alleen `customer.create` — POST /api/customer accepteert nu
--     verifyAdmin OR requirePermission('customer.create') (sinds deze commit).
--   - Insert doet ALLEEN customers-tabel + audit. GEEN TeamLeader-sync,
--     GEEN subscription, GEEN invoice, GEEN incasso-side-effect.
--     (tlFetch elders in customer.js zit alleen in PATCH-pad, blijft admin.)
--   - Bewerken/archiveren/verwijderen/tags/notes/AVG blijven strikt
--     verifyAdmin via bestaande gates in api/customer.js POST/PATCH +
--     api/customer-*.js. Sales én mentor krijgen hier NIETS bij.
--
-- Blast-radius: alle sales- én alle mentor-users (Dave; Chesney, Seppe e.a.).
-- Bevestigd door Jeffrey.
--
-- Idempotent: ON CONFLICT (role, feature_key) DO UPDATE SET allowed = true
-- (fix voor DO NOTHING dat een bestaande `allowed=false` zou laten staan).
-- ============================================================================

BEGIN;

INSERT INTO public.role_permissions (role, feature_key, allowed) VALUES
  ('sales',  'customer.create', true),
  ('mentor', 'customer.create', true)
ON CONFLICT (role, feature_key) DO UPDATE SET allowed = EXCLUDED.allowed;

COMMIT;

-- ============================================================================
-- VERIFICATIE (draai NA COMMIT)
-- ============================================================================
-- 1. Grants staan:
--    SELECT role, feature_key, allowed
--      FROM public.role_permissions
--     WHERE feature_key = 'customer.create'
--     ORDER BY role;
--    Verwacht: sales + mentor — allowed=true.
--
-- 2. Sanity dat sales/mentor NIET ineens ook edit/archive/hard_delete hebben:
--    SELECT role, feature_key FROM public.role_permissions
--     WHERE role IN ('sales','mentor')
--       AND feature_key IN ('customer.edit','customer.archive','customer.hard_delete','customer.tag_manage');
--    Verwacht: 0 rijen.
--
-- 3. RPC-check voor Dave (sales) + Chesney / Seppe (mentor):
--    SELECT public.user_has_permission('<DAVE_USER_ID>'::uuid,    'customer.create');
--    SELECT public.user_has_permission('<CHESNEY_USER_ID>'::uuid, 'customer.create');
--    -- Chesney: 9f4cd827-9529-4647-bdd3-2db4cd340bab
--    Verwacht: true / true.
--
-- 4. Alle actieve sales + mentor tegelijk:
--    SELECT p.full_name, p.email, p.role,
--           public.user_has_permission(p.id, 'customer.create') AS mag_aanmaken
--      FROM public.profiles p
--     WHERE p.role IN ('sales','mentor') AND p.is_active = true
--     ORDER BY p.role, p.full_name;
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- BEGIN;
-- UPDATE public.role_permissions
--    SET allowed = false
--  WHERE role IN ('sales','mentor') AND feature_key = 'customer.create';
-- -- Of definitief:
-- -- DELETE FROM public.role_permissions
-- --  WHERE role IN ('sales','mentor') AND feature_key = 'customer.create';
-- COMMIT;
-- ============================================================================
