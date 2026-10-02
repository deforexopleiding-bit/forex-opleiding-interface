-- ═══════════════════════════════════════════════════════════════════════════
-- Call-rapport (Opvolging → tab Call-rapport, /api/call-rapport)
-- 1 oktober 2026
--
-- Twee losse dingen, allebei idempotent en allebei NIET BLOKKEREND:
--   1. De rechtensleutel calls.rapport.view voor de rollen naast super_admin.
--   2. De startdatum van de call-rapportage expliciet in app_settings.
--
-- Puur additief. Geen tabel, kolom, index, policy of constraint aangeraakt.
-- Elk statement staat op zichzelf (geen BEGIN/COMMIT nodig): het knippen op
-- statement-grenzen door de Supabase SQL-editor is hier onschadelijk.
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════
-- DEEL 1 · De rechtensleutel calls.rapport.view
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Niet blokkerend voor super_admin: die heeft een eigen OR-tak in
-- public.user_has_permission() en ziet het rapport ook zonder deze rijen.
-- Zonder deel 1 krijgt een manager een 403 op /api/call-rapport (strikte
-- requirePermission, geen terugval op een andere sleutel).
--
-- WAAROM EEN EIGEN SLEUTEL EN NIET opvolging.rapport.view
-- Die staat voor sales op true: Dave ziet zijn eigen Salesrapport. Dit rapport
-- zet ALLE closers en de setters (Romy) naast elkaar — managementinformatie
-- over meerdere mensen. Meeliften zou Dave de cijfers van collega's tonen.
--
-- ROL-TOEWIJZING
--   manager        → true   (stuurt closers en setters aan; zelfde als bij
--                            opvolging.rapport.view)
--   sales          → false  (het verschil met opvolging.rapport.view)
--   mentor         → false
--   administratie  → false
--   marketing      → false
--   super_admin    → geen rij nodig; eigen OR-tak in de functie
--   admin          → bewust niet, net als bij de andere opvolging-sleutels
--                    (de rol is voor deze module niet in gebruik; later
--                    toevoegen kan met dezelfde NOT EXISTS-vorm)
--
-- Rijen met false verlenen niets en blokkeren niets; ze leggen vast dat er
-- over nagedacht is (zie 2026-09-04-opvolging-role-permissions.sql).

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'manager', 'calls.rapport.view', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='manager' AND feature_key='calls.rapport.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'sales', 'calls.rapport.view', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='sales' AND feature_key='calls.rapport.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'mentor', 'calls.rapport.view', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='mentor' AND feature_key='calls.rapport.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'administratie', 'calls.rapport.view', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='administratie' AND feature_key='calls.rapport.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'marketing', 'calls.rapport.view', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='marketing' AND feature_key='calls.rapport.view');


-- ═══════════════════════════════════════════════════════════════════════════
-- DEEL 2 · De startdatum van de call-rapportage (optioneel)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- api/_lib/call-rapportage-start.js leest deze sleutel. Ontbreekt de rij, dan
-- geldt de standaard in de code (2026-10-02) — dit statement legt die waarde
-- alleen expliciet vast, zodat hij zonder deploy te verschuiven is.
-- ON CONFLICT DO NOTHING: een waarde die er al staat blijft staan.

INSERT INTO public.app_settings (key, value)
VALUES ('call_rapportage_startdatum', '{"datum": "2026-10-02"}'::jsonb)
ON CONFLICT (key) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════════════
-- CONTROLE (los te draaien)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 1 · Verwacht: 5 rijen, alleen manager true.
--   SELECT role, allowed FROM public.role_permissions
--   WHERE feature_key = 'calls.rapport.view' ORDER BY role;
--
-- 2 · Verwacht: {"datum": "2026-10-02"} (of de waarde die er al stond).
--   SELECT value FROM public.app_settings WHERE key = 'call_rapportage_startdatum';
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK (indien nodig)
-- ═══════════════════════════════════════════════════════════════════════════
--   DELETE FROM public.role_permissions WHERE feature_key = 'calls.rapport.view';
--   DELETE FROM public.app_settings WHERE key = 'call_rapportage_startdatum';
--   (Let op: de tweede regel raakt ook de topbar en het setter-overzicht, die
--    dezelfde sleutel lezen. Zonder rij valt alles terug op 2026-10-02.)
