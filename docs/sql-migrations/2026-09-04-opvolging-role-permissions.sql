-- ============================================================================
-- Opvolging-module — role-grants voor de acht permission-keys
-- Datum: 2026-09-04
-- Branch: docs/opvolging-role-permissions-migratie
--
-- VASTLEGGING ACHTERAF. Deze rijen zijn op 4 september 2026 met de hand in de
-- databank gezet omdat de module anders voor iedereen dichtzat. Dit bestand is
-- de herhaalbare versie daarvan, zodat de stand van productie ook uit de repo
-- te reconstrueren is en een verse omgeving niet opnieuw tegen hetzelfde
-- probleem aanloopt.
--
-- ── WAAROM DEZE RIJEN NODIG ZIJN ────────────────────────────────────────────
-- Er bestond geen enkele rij in role_permissions voor de opvolging-keys. De
-- DB-functie public.user_has_permission() (migratie 016, die 002 vervangt)
-- beslist met een EXISTS over role_permissions:
--
--     EXISTS (SELECT 1 FROM user_roles ur
--             JOIN role_permissions rp ON rp.role = ur.role
--             WHERE ur.user_id = user_uuid
--               AND rp.feature_key = fkey
--               AND rp.allowed = true)
--
-- Geen rij betekent dus: EXISTS is false, de functie geeft false. En de strikte
-- requirePermission() in api/_lib/requirePermission.js geeft daarop een 403:
--
--     const allowed = data === true;   // data was null/false → 403
--
-- Netto kwam iedereen behalve super_admin (die een eigen OR-tak heeft) op een
-- 403 bij /api/opvolging-taken, -dag, -taak-update, -poging, -agenda,
-- -taak-create en de drie whatsapp-endpoints. Niet omdat iets geweigerd werd,
-- maar omdat er niets stond.
--
-- ── LET OP BIJ allowed = false ──────────────────────────────────────────────
-- De EXISTS hierboven eist `allowed = true`. Een rij met false verleent dus
-- niets, maar blokkeert ook niets: hij is functioneel gelijk aan géén rij. We
-- zetten ze toch neer omdat ze het verschil vastleggen tussen "bewust niet
-- toegekend" en "nog niet over nagedacht" — en omdat de rollenmatrix in
-- modules/admin.html ze dan als expliciet uitgezet vinkje toont in plaats van
-- als leeg vakje. Wie een rol alsnog toegang wil geven zet allowed op true;
-- een rij weghalen heeft hetzelfde effect als false.
--
-- ── ROL-TOEWIJZING ──────────────────────────────────────────────────────────
-- Zelfde patroon als de bestaande followup.*-keys:
--   manager        → true   (stuurt de opvolging aan, ziet de historiek)
--   sales          → true   (voert de belrondes uit)
--   mentor         → false
--   administratie  → false
--   marketing      → false
--   super_admin    → geen rij nodig; heeft een eigen OR-tak in de functie
--   admin / viewer → bewust niet in deze migratie (geen van beide rollen is in
--                    gebruik voor deze module; toevoegen kan later met dezelfde
--                    NOT EXISTS-vorm)
--
-- 8 keys × 5 rollen = 40 rijen.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- Elke INSERT staat achter een NOT EXISTS op (role, feature_key) — de primary
-- key van de tabel. Opnieuw draaien voegt niets toe en wijzigt niets, ook geen
-- allowed-waarde die iemand later met de hand heeft aangepast.
--
-- De statements zijn los van elkaar idempotent, dus het maakt niet uit of de
-- Supabase SQL-editor de invoer op statement-grenzen knipt (zie CLAUDE.md over
-- de editor die elk statement in een eigen transactie draait).
-- ============================================================================

BEGIN;

-- ── manager — volledige toegang ─────────────────────────────────────────────
INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'manager', 'opvolging.module.access', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='manager' AND feature_key='opvolging.module.access');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'manager', 'opvolging.dag.view', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='manager' AND feature_key='opvolging.dag.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'manager', 'opvolging.dashboard.view', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='manager' AND feature_key='opvolging.dashboard.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'manager', 'opvolging.archief.view', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='manager' AND feature_key='opvolging.archief.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'manager', 'opvolging.taak.afronden', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='manager' AND feature_key='opvolging.taak.afronden');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'manager', 'opvolging.taak.archiveren', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='manager' AND feature_key='opvolging.taak.archiveren');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'manager', 'opvolging.agenda.boeken', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='manager' AND feature_key='opvolging.agenda.boeken');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'manager', 'opvolging.whatsapp.sturen', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='manager' AND feature_key='opvolging.whatsapp.sturen');

-- ── sales — volledige toegang ───────────────────────────────────────────────
INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'sales', 'opvolging.module.access', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='sales' AND feature_key='opvolging.module.access');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'sales', 'opvolging.dag.view', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='sales' AND feature_key='opvolging.dag.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'sales', 'opvolging.dashboard.view', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='sales' AND feature_key='opvolging.dashboard.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'sales', 'opvolging.archief.view', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='sales' AND feature_key='opvolging.archief.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'sales', 'opvolging.taak.afronden', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='sales' AND feature_key='opvolging.taak.afronden');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'sales', 'opvolging.taak.archiveren', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='sales' AND feature_key='opvolging.taak.archiveren');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'sales', 'opvolging.agenda.boeken', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='sales' AND feature_key='opvolging.agenda.boeken');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'sales', 'opvolging.whatsapp.sturen', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='sales' AND feature_key='opvolging.whatsapp.sturen');

-- ── mentor — bewust niet toegekend ──────────────────────────────────────────
INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'mentor', 'opvolging.module.access', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='mentor' AND feature_key='opvolging.module.access');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'mentor', 'opvolging.dag.view', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='mentor' AND feature_key='opvolging.dag.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'mentor', 'opvolging.dashboard.view', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='mentor' AND feature_key='opvolging.dashboard.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'mentor', 'opvolging.archief.view', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='mentor' AND feature_key='opvolging.archief.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'mentor', 'opvolging.taak.afronden', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='mentor' AND feature_key='opvolging.taak.afronden');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'mentor', 'opvolging.taak.archiveren', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='mentor' AND feature_key='opvolging.taak.archiveren');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'mentor', 'opvolging.agenda.boeken', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='mentor' AND feature_key='opvolging.agenda.boeken');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'mentor', 'opvolging.whatsapp.sturen', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='mentor' AND feature_key='opvolging.whatsapp.sturen');

-- ── administratie — bewust niet toegekend ───────────────────────────────────
INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'administratie', 'opvolging.module.access', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='administratie' AND feature_key='opvolging.module.access');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'administratie', 'opvolging.dag.view', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='administratie' AND feature_key='opvolging.dag.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'administratie', 'opvolging.dashboard.view', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='administratie' AND feature_key='opvolging.dashboard.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'administratie', 'opvolging.archief.view', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='administratie' AND feature_key='opvolging.archief.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'administratie', 'opvolging.taak.afronden', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='administratie' AND feature_key='opvolging.taak.afronden');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'administratie', 'opvolging.taak.archiveren', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='administratie' AND feature_key='opvolging.taak.archiveren');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'administratie', 'opvolging.agenda.boeken', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='administratie' AND feature_key='opvolging.agenda.boeken');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'administratie', 'opvolging.whatsapp.sturen', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='administratie' AND feature_key='opvolging.whatsapp.sturen');

-- ── marketing — bewust niet toegekend ───────────────────────────────────────
INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'marketing', 'opvolging.module.access', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='marketing' AND feature_key='opvolging.module.access');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'marketing', 'opvolging.dag.view', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='marketing' AND feature_key='opvolging.dag.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'marketing', 'opvolging.dashboard.view', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='marketing' AND feature_key='opvolging.dashboard.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'marketing', 'opvolging.archief.view', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='marketing' AND feature_key='opvolging.archief.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'marketing', 'opvolging.taak.afronden', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='marketing' AND feature_key='opvolging.taak.afronden');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'marketing', 'opvolging.taak.archiveren', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='marketing' AND feature_key='opvolging.taak.archiveren');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'marketing', 'opvolging.agenda.boeken', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='marketing' AND feature_key='opvolging.agenda.boeken');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'marketing', 'opvolging.whatsapp.sturen', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='marketing' AND feature_key='opvolging.whatsapp.sturen');

COMMIT;

-- ── CONTROLE (los te draaien) ───────────────────────────────────────────────
-- Verwacht: 40 rijen, waarvan 16 met allowed = true.
--
-- SELECT role, count(*) AS rijen, count(*) FILTER (WHERE allowed) AS toegestaan
-- FROM public.role_permissions
-- WHERE feature_key LIKE 'opvolging.%'
-- GROUP BY role ORDER BY role;

-- ── ROLLBACK (indien nodig) ─────────────────────────────────────────────────
-- Let op: hiermee zit de module weer voor iedereen behalve super_admin dicht.
--
-- DELETE FROM public.role_permissions
-- WHERE feature_key LIKE 'opvolging.%'
--   AND role IN ('manager','sales','mentor','administratie','marketing');
