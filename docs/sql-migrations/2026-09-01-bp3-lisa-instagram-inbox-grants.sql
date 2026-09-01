-- ============================================================================
-- BP3 · Instagram-inbox voor Romy — RBAC-grants (rechten-seed)
-- Datum: 2026-09-01
-- Doel : geef Romy (rol 'appointmentsetter') toegang tot de Lisa Gesprekken-view
--        zodat ze IG-DM's kan lezen én beantwoorden (takeover / intervene /
--        status_update / booking-link versturen). Voorkom regressie voor manager
--        door dezelfde fine-grained conversation-keys ook aan manager toe te
--        kennen (admin heeft geen rij nodig — heeft geen wildcard, dus krijgt
--        expliciet dezelfde grants). super_admin bypasst alles via
--        is_super_admin().
--
-- WAT DIT NIET DOET
--   - Geen tabelwijziging.
--   - Geen data-migratie.
--   - Geen scope-tabellen aanmaken.
--   - Geen incasso-writes.
--
-- IDEMPOTENT
--   ON CONFLICT (role, feature_key) DO NOTHING — herhaald draaien is veilig.
--
-- CONTEXT (nieuwe fine-grained keys sinds registry-uitbreiding)
--   Registry (modules/shared/rbac/registry.js:80-94) definieert al:
--     lisa.module.access
--     lisa.conversation.view
--     lisa.conversation.takeover
--     lisa.conversation.intervene
--     lisa.conversation.status_update
--     lisa.config.view / .edit / .publish
--     lisa.sandbox.use
--     lisa.feedback.give
--     lisa.kb.edit
--     lisa.stats.view / .logs.view
--
--   Manager had via migratie 014 al: module.access, config.view/edit/publish,
--   sandbox.use — MAAR mist de conversation.*-keys. Endpoint-refactor
--   (verifyAdmin → requirePermission('lisa.conversation.view')) zou zonder
--   deze grants een regressie geven → daarom voegen we ze hier expliciet
--   toe voor manager én admin. super_admin bypasst.
--
-- POST-CHECK QUERIES (na draaien, ter verificatie)
--   -- 1. Zie welke rollen welke lisa-keys hebben.
--   SELECT role, feature_key FROM public.role_permissions
--   WHERE feature_key LIKE 'lisa.%'
--   ORDER BY role, feature_key;
--
--   -- 2. Romy's effectieve permissies checken (vervang <romy-uuid>).
--   SELECT public.user_has_permission('<romy-uuid>'::uuid, 'lisa.conversation.view') AS view,
--          public.user_has_permission('<romy-uuid>'::uuid, 'lisa.conversation.intervene') AS intervene,
--          public.user_has_permission('<romy-uuid>'::uuid, 'lisa.conversation.takeover') AS takeover,
--          public.user_has_permission('<romy-uuid>'::uuid, 'lisa.conversation.status_update') AS statusupd,
--          public.user_has_permission('<romy-uuid>'::uuid, 'lisa.module.access') AS module,
--          public.user_has_permission('<romy-uuid>'::uuid, 'lisa.config.view') AS cfgview;
--   -- Verwacht: alles TRUE behalve cfgview (FALSE — Romy krijgt géén config-toegang).
--
-- ROLLBACK (indien nodig)
--   DELETE FROM public.role_permissions
--   WHERE (role, feature_key) IN (
--     ('appointmentsetter','lisa.module.access'),
--     ('appointmentsetter','lisa.conversation.view'),
--     ('appointmentsetter','lisa.conversation.intervene'),
--     ('appointmentsetter','lisa.conversation.takeover'),
--     ('appointmentsetter','lisa.conversation.status_update'),
--     ('manager','lisa.conversation.view'),
--     ('manager','lisa.conversation.intervene'),
--     ('manager','lisa.conversation.takeover'),
--     ('manager','lisa.conversation.status_update'),
--     ('admin','lisa.module.access'),
--     ('admin','lisa.conversation.view'),
--     ('admin','lisa.conversation.intervene'),
--     ('admin','lisa.conversation.takeover'),
--     ('admin','lisa.conversation.status_update'),
--     ('admin','lisa.config.view'),
--     ('admin','lisa.config.edit'),
--     ('admin','lisa.config.publish'),
--     ('admin','lisa.sandbox.use')
--   );
-- ============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) APPOINTMENTSETTER (Romy) — alleen Gesprekken-scope, GEEN config
-- ─────────────────────────────────────────────────────────────────────────────
--
-- module.access             — sidebar-item + top-level MOD in de shell.
-- conversation.view         — GET /api/lisa-conversations (list_live + detail).
-- conversation.intervene    — POST /api/lisa-conversations?action=intervene
--                             (mens neemt over en stuurt bericht via GHL).
-- conversation.takeover     — PATCH { human_takeover:true/false } (toggle-flag
--                             op de conv-rij; Lisa stopt met auto-antwoorden).
-- conversation.status_update — PATCH { phase / qualified / call_booked /
--                             followup_paused / disqualified_reason }.
--
-- BEWUST NIET voor Romy:
--   config.view/edit/publish   — geen Lisa-instellingen bewerken.
--   sandbox.use                — geen sandbox-chat.
--   feedback.give              — geen thumbs-up/down op AI-berichten.
--   kb.edit                    — geen kennisbank bewerken.
--   stats.view / logs.view     — geen dashboard/statistieken/logboek.
--
INSERT INTO public.role_permissions (role, feature_key, allowed) VALUES
  ('appointmentsetter', 'lisa.module.access',              true),
  ('appointmentsetter', 'lisa.conversation.view',          true),
  ('appointmentsetter', 'lisa.conversation.intervene',     true),
  ('appointmentsetter', 'lisa.conversation.takeover',      true),
  ('appointmentsetter', 'lisa.conversation.status_update', true)
ON CONFLICT (role, feature_key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) MANAGER — regressie-preventie voor de auth-refactor
-- ─────────────────────────────────────────────────────────────────────────────
-- Manager had via migratie 014 al: module.access, config.view/edit/publish,
-- sandbox.use. De conversation.*-keys ontbraken; die zijn na de refactor
-- vereist om de Gesprekken-view + intervene/PATCH te kunnen gebruiken.
INSERT INTO public.role_permissions (role, feature_key, allowed) VALUES
  ('manager', 'lisa.conversation.view',                    true),
  ('manager', 'lisa.conversation.intervene',               true),
  ('manager', 'lisa.conversation.takeover',                true),
  ('manager', 'lisa.conversation.status_update',           true)
ON CONFLICT (role, feature_key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) ADMIN — expliciet, geen wildcard
-- ─────────────────────────────────────────────────────────────────────────────
-- user_has_permission() heeft alleen een bypass voor super_admin. Admin moet
-- dus per feature-key een rij hebben. Migratie 014 gaf admin geen Lisa-grants
-- (module was in productie via role-check `verifyAdmin`, geen RBAC). Na de
-- refactor is de admin-rol NIET meer automatisch toegelaten via verifyAdmin →
-- daarom seeden we hier volledige Lisa-toegang voor admin (inclusief config).
INSERT INTO public.role_permissions (role, feature_key, allowed) VALUES
  ('admin', 'lisa.module.access',                          true),
  ('admin', 'lisa.conversation.view',                      true),
  ('admin', 'lisa.conversation.intervene',                 true),
  ('admin', 'lisa.conversation.takeover',                  true),
  ('admin', 'lisa.conversation.status_update',             true),
  ('admin', 'lisa.config.view',                            true),
  ('admin', 'lisa.config.edit',                            true),
  ('admin', 'lisa.config.publish',                         true),
  ('admin', 'lisa.sandbox.use',                            true)
ON CONFLICT (role, feature_key) DO NOTHING;

-- super_admin: geen rij nodig — bypass via is_super_admin() in
-- user_has_permission() (migratie 002).

COMMIT;

-- ============================================================================
-- KLAAR. Verifieer met de POST-CHECK QUERIES boven. Daarna kan de code-refactor
-- (auth-endpoints + MOD + sidebar-deeplink) veilig gedeployed worden.
-- ============================================================================
