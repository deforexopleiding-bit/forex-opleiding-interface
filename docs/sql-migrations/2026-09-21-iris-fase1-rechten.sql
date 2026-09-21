-- ============================================================================
-- Iris — fase 1: de rechten
-- Datum: 21 september 2026
-- Hoort bij: docs/sql-migrations/2026-09-21-iris-fase1-datamodel.sql
--
-- ── WAAROM DIT BESTAND NODIG IS ─────────────────────────────────────────────
-- public.user_has_permission() beslist met een EXISTS over role_permissions en
-- eist daarbij allowed = true. Een ONTBREKENDE rij en een rij met false zijn
-- voor die functie dus hetzelfde, en requirePermission() maakt daar een 403
-- van. Zonder dit bestand zit Iris dicht voor iedereen behalve super_admin.
--
-- Zelfde vorm als docs/sql-migrations/2026-09-04-opvolging-role-permissions.sql.
--
-- ── WAAROM OOK DE false-RIJEN ───────────────────────────────────────────────
-- Een rij met false verleent niets en blokkeert niets — functioneel gelijk aan
-- geen rij. We zetten ze toch neer omdat ze het verschil vastleggen tussen
-- "bewust niet toegekend" en "nog niet over nagedacht", en omdat de
-- rollenmatrix in modules/admin.html ze dan als een uitgezet vinkje toont in
-- plaats van als een leeg vakje.
--
-- ── super_admin ─────────────────────────────────────────────────────────────
-- Heeft een eigen OR-tak in de functie en heeft hier dus geen rij nodig.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- Elke INSERT staat achter een NOT EXISTS op (role, feature_key). Opnieuw
-- draaien voegt niets toe en overschrijft geen allowed-waarde die iemand later
-- met de hand heeft aangepast.
--
-- ── DE SLEUTELS ─────────────────────────────────────────────────────────────
--   iris.view                de module openen en meelezen
--   iris.post.beantwoorden   een concept maken of aanpassen
--   iris.versturen           een bericht daadwerkelijk de deur uit doen
--   iris.lms.acties          toegang verlengen, uitnodiging opnieuw, on hold
--   iris.belrij              de belrij zien en afwerken
--   iris.instellingen        autonomie en drempels wijzigen
-- ============================================================================

-- ── manager — Maxim. Alles. ────────────────────────────────────────────────
INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'manager', 'iris.view', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='manager' AND feature_key='iris.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'manager', 'iris.post.beantwoorden', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='manager' AND feature_key='iris.post.beantwoorden');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'manager', 'iris.versturen', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='manager' AND feature_key='iris.versturen');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'manager', 'iris.lms.acties', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='manager' AND feature_key='iris.lms.acties');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'manager', 'iris.belrij', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='manager' AND feature_key='iris.belrij');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'manager', 'iris.instellingen', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='manager' AND feature_key='iris.instellingen');

-- ── admin — gelijk aan manager; de rol wordt vandaag niet gebruikt maar hoort niet stilzwijgend anders te zijn. 
INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'admin', 'iris.view', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='admin' AND feature_key='iris.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'admin', 'iris.post.beantwoorden', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='admin' AND feature_key='iris.post.beantwoorden');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'admin', 'iris.versturen', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='admin' AND feature_key='iris.versturen');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'admin', 'iris.lms.acties', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='admin' AND feature_key='iris.lms.acties');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'admin', 'iris.belrij', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='admin' AND feature_key='iris.belrij');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'admin', 'iris.instellingen', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='admin' AND feature_key='iris.instellingen');

-- ── sales — Dave. Alles behalve de instellingen — de autonomie blijft bij Maxim. 
INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'sales', 'iris.view', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='sales' AND feature_key='iris.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'sales', 'iris.post.beantwoorden', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='sales' AND feature_key='iris.post.beantwoorden');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'sales', 'iris.versturen', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='sales' AND feature_key='iris.versturen');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'sales', 'iris.lms.acties', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='sales' AND feature_key='iris.lms.acties');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'sales', 'iris.belrij', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='sales' AND feature_key='iris.belrij');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'sales', 'iris.instellingen', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='sales' AND feature_key='iris.instellingen');

-- ── administratie — meelezen, schrijven, versturen en bellen. Geen LMS-acties en geen instellingen. 
INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'administratie', 'iris.view', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='administratie' AND feature_key='iris.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'administratie', 'iris.post.beantwoorden', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='administratie' AND feature_key='iris.post.beantwoorden');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'administratie', 'iris.versturen', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='administratie' AND feature_key='iris.versturen');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'administratie', 'iris.lms.acties', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='administratie' AND feature_key='iris.lms.acties');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'administratie', 'iris.belrij', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='administratie' AND feature_key='iris.belrij');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'administratie', 'iris.instellingen', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='administratie' AND feature_key='iris.instellingen');

-- ── mentor — geen toegang tot Iris. Uitdrukkelijk zo afgesproken. ──────────
INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'mentor', 'iris.view', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='mentor' AND feature_key='iris.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'mentor', 'iris.post.beantwoorden', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='mentor' AND feature_key='iris.post.beantwoorden');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'mentor', 'iris.versturen', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='mentor' AND feature_key='iris.versturen');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'mentor', 'iris.lms.acties', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='mentor' AND feature_key='iris.lms.acties');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'mentor', 'iris.belrij', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='mentor' AND feature_key='iris.belrij');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'mentor', 'iris.instellingen', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='mentor' AND feature_key='iris.instellingen');

-- ── marketing — geen toegang. ──────────────────────────────────────────────
INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'marketing', 'iris.view', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='marketing' AND feature_key='iris.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'marketing', 'iris.post.beantwoorden', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='marketing' AND feature_key='iris.post.beantwoorden');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'marketing', 'iris.versturen', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='marketing' AND feature_key='iris.versturen');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'marketing', 'iris.lms.acties', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='marketing' AND feature_key='iris.lms.acties');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'marketing', 'iris.belrij', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='marketing' AND feature_key='iris.belrij');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'marketing', 'iris.instellingen', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='marketing' AND feature_key='iris.instellingen');

-- ── appointmentsetter — geen toegang; die rol landt op leadsonderhoud. ─────
INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'appointmentsetter', 'iris.view', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='appointmentsetter' AND feature_key='iris.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'appointmentsetter', 'iris.post.beantwoorden', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='appointmentsetter' AND feature_key='iris.post.beantwoorden');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'appointmentsetter', 'iris.versturen', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='appointmentsetter' AND feature_key='iris.versturen');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'appointmentsetter', 'iris.lms.acties', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='appointmentsetter' AND feature_key='iris.lms.acties');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'appointmentsetter', 'iris.belrij', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='appointmentsetter' AND feature_key='iris.belrij');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'appointmentsetter', 'iris.instellingen', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='appointmentsetter' AND feature_key='iris.instellingen');


-- ── Nakijken ────────────────────────────────────────────────────────────────
--   SELECT role, feature_key, allowed
--     FROM public.role_permissions
--    WHERE feature_key LIKE 'iris.%'
--    ORDER BY feature_key, role;
--   -- verwacht: 7 rollen x 6 sleutels = 42 rijen
