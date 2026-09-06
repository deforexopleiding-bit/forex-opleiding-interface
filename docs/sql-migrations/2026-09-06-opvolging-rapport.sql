-- ═══════════════════════════════════════════════════════════════════════════
-- Opvolging · het dagrapport (item R)
-- 6 september 2026
--
-- Twee losse dingen in één bestand, zodat het in één keer te draaien is:
--   1. Twee kolommen op follow_up_appointments — de uitkomst van een zoomcall
--      als GEBEURTENIS in plaats van als huidige stand.
--   2. De rechtensleutel opvolging.rapport.view voor de vijf rollen.
--
-- Puur additief. Geen bestaande kolom, index, policy of constraint aangeraakt.
-- Idempotent: veilig om opnieuw te draaien.
--
-- NIET BLOKKEREND. De code die deze kolommen schrijft doet dat in een APARTE
-- update met dezelfde fail-soft als prev_state (zie writeUitkomst in
-- api/follow-up-appointment-outcome.js). Draait deze migratie niet, dan blijft
-- de uitkomst-motor gewoon werken en logt hij één waarschuwing; het rapport
-- zegt dan bij elke call 'geen uitkomst vastgelegd'. Dat is de eerlijke stand,
-- niet een storing. De rechtensleutel is dat WEL — zie deel 2.
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════
-- DEEL 1 · De uitkomst van een zoomcall wordt een gebeurtenis
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WAAROM `status` HIER NIET VOLDOET — en dit is de hele reden voor deel 1.
--
-- Sinds item Q schrijft de cockpit de uitkomst van een zoomcall weg. Hij landt
-- op follow_up_appointments.status. Daar zijn drie dingen mis mee zodra je er
-- een rapport over een PERIODE op wilt bouwen:
--
--   1. `status` is de HUIDIGE STAND, geen gebeurtenis. Wordt dezelfde afspraak
--      later verzet of geannuleerd, dan verandert het rapport over vorige week
--      met terugwerkende kracht. Een rapport over dinsdag moet in oktober nog
--      steeds dinsdag tonen.
--
--   2. `updated_at` is de LAATSTE AANRAKING, niet het moment van de uitkomst.
--      Elke latere schrijfactie op die rij schuift hem op.
--
--   3. DE VIER UITKOMSTEN ZIJN NIET TERUG TE LEZEN. `sale` en `gesprek_gehad`
--      worden allebei 'completed'; `wilt_niet_meer` en `niet_geschikt` allebei
--      'cancelled'. Uit de status is dus niet af te leiden of er verkocht is —
--      precies het cijfer waar het rapport over gaat.
--
-- Het enige bestaande spoor is de regel die appendApptNote in `snelle_notitie`
-- zet, met een tijdstempel ervoor. Dat is append-only en dus wél een
-- gebeurtenis — maar die uitparseren is tekstparsing op een zin die iemand ooit
-- anders formuleert. Dat is op 6 september twee keer de oorzaak van een fout
-- cijfer geweest (de richting van een WhatsApp-bericht, en of een call
-- gesproken was). Dus: een kolom, geen parser.
--
-- WAT ER NADRUKKELIJK NIET GEBEURT
-- Deze migratie vult de kolommen NIET met terugwerkende kracht uit `status`.
-- Dat zou een gok zijn: 'completed' kan sale of gesprek_gehad zijn geweest, en
-- welke van de twee is niet meer te achterhalen. Alle afspraken van vóór
-- vandaag houden dus NULL, en het rapport zegt daarvoor 'geen uitkomst
-- vastgelegd' in plaats van te raden. Dat is dezelfde verleiding als de
-- tekstparser, en het antwoord is hetzelfde: niet doen.
--
-- WAAROM GEEN CHECK-CONSTRAINT OP `uitkomst`
-- De waardenlijst staat in OUTCOMES in api/follow-up-appointment-outcome.js en
-- die divergeert bewust van de lijst in api/follow-up-outcomes.js (zie het
-- waarschuwingsblok in dat bestand). Een CHECK hier zou een derde plek worden
-- waar die lijst staat, en de eerste die uit de pas loopt laat de motor
-- stilvallen op een insert-fout in plaats van op een leesbare melding. De
-- kolom is een logboek van wat de motor deed, geen poort.

ALTER TABLE public.follow_up_appointments
  ADD COLUMN IF NOT EXISTS uitkomst text;

ALTER TABLE public.follow_up_appointments
  ADD COLUMN IF NOT EXISTS uitkomst_op timestamptz;

COMMENT ON COLUMN public.follow_up_appointments.uitkomst IS
  'De uitkomst zoals de motor hem zette (sale / gesprek_gehad / wilt_niet_meer / niet_geschikt / no_show / later_opnieuw / terugbel). NULL = niet vastgelegd; NOOIT afleiden uit status — completed dekt zowel sale als gesprek_gehad.';

COMMENT ON COLUMN public.follow_up_appointments.uitkomst_op IS
  'Het moment waarop die uitkomst gezet werd. Niet updated_at: die schuift op bij elke latere aanraking van de rij.';

-- Het rapport selecteert op een periode van uitkomst_op. Partieel, want
-- verreweg de meeste rijen houden NULL.
CREATE INDEX IF NOT EXISTS follow_up_appointments_uitkomst_op_idx
  ON public.follow_up_appointments (uitkomst_op)
  WHERE uitkomst_op IS NOT NULL;


-- ═══════════════════════════════════════════════════════════════════════════
-- DEEL 2 · De rechtensleutel opvolging.rapport.view
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ⚠ DIT DEEL IS WEL BLOKKEREND. public.user_has_permission() beslist met een
-- EXISTS over role_permissions; geen rij betekent false, en de strikte
-- requirePermission() maakt daar een 403 van. Draait dit deel niet, dan geeft
-- /api/opvolging-rapport voor iedereen behalve super_admin een 403 en blijft
-- het tabblad leeg met de melding dat de rechten ontbreken.
--
-- Dat is met opzet zo gebouwd. Er wordt NIET stil teruggevallen op
-- opvolging.module.access of opvolging.dashboard.view als deze sleutel
-- ontbreekt: dan zou een beheerder die het rapport uitzet niets zien gebeuren,
-- en dat is precies het soort stille terugval waar deze module vandaag drie
-- keer op is vastgelopen.
--
-- ROL-TOEWIJZING — gelijk aan opvolging.dashboard.view, en dat is een keuze:
--   manager        → true   (voert het gesprek met Dave)
--   sales          → true   (Dave zelf; Maxim heeft dat op 6 sep bevestigd —
--                            wie ziet waar hij op afgerekend wordt kan zelf
--                            bijsturen, en dan gaat het gesprek over de leads
--                            die bleven liggen in plaats van over de cijfers)
--   mentor         → false
--   administratie  → false
--   marketing      → false
--   super_admin    → geen rij nodig; eigen OR-tak in de functie
--
-- Een rij met allowed = false verleent niets en blokkeert niets — functioneel
-- gelijk aan géén rij. Ze staan er toch, zodat de rollenmatrix in
-- modules/admin.html het verschil toont tussen 'bewust uit' en 'nog niet over
-- nagedacht'. Zelfde patroon als 2026-09-04-opvolging-role-permissions.sql.
--
-- Elke INSERT staat achter een NOT EXISTS op (role, feature_key), de primary
-- key van de tabel. Opnieuw draaien wijzigt niets, ook geen allowed-waarde die
-- iemand later met de hand heeft aangepast. De statements zijn los van elkaar
-- idempotent, dus het knippen op statement-grenzen door de Supabase SQL-editor
-- is hier onschadelijk.

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'manager', 'opvolging.rapport.view', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='manager' AND feature_key='opvolging.rapport.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'sales', 'opvolging.rapport.view', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='sales' AND feature_key='opvolging.rapport.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'mentor', 'opvolging.rapport.view', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='mentor' AND feature_key='opvolging.rapport.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'administratie', 'opvolging.rapport.view', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='administratie' AND feature_key='opvolging.rapport.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'marketing', 'opvolging.rapport.view', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='marketing' AND feature_key='opvolging.rapport.view');


-- ═══════════════════════════════════════════════════════════════════════════
-- CONTROLE (los te draaien)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 1 · De twee kolommen bestaan en zijn nullable. Verwacht: 2 rijen, YES.
--
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'follow_up_appointments'
--     AND column_name IN ('uitkomst', 'uitkomst_op');
--
-- 2 · Niemand is met terugwerkende kracht ingevuld. Verwacht: 0.
--
--   SELECT count(*) FROM public.follow_up_appointments WHERE uitkomst IS NOT NULL;
--
-- 3 · De rechtensleutel staat er voor vijf rollen, twee op true.
--     Verwacht: 5 rijen; manager en sales true, de rest false.
--
--   SELECT role, allowed FROM public.role_permissions
--   WHERE feature_key = 'opvolging.rapport.view' ORDER BY role;
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK (indien nodig)
-- ═══════════════════════════════════════════════════════════════════════════
-- Deel 1 kost gegevens: de kolommen dragen uitkomsten die nergens anders in
-- deze vorm staan. Alleen doen als deel 1 nog niets geschreven heeft
-- (controle 2 geeft 0).
--
--   DROP INDEX IF EXISTS public.follow_up_appointments_uitkomst_op_idx;
--   ALTER TABLE public.follow_up_appointments DROP COLUMN IF EXISTS uitkomst_op;
--   ALTER TABLE public.follow_up_appointments DROP COLUMN IF EXISTS uitkomst;
--
--   DELETE FROM public.role_permissions WHERE feature_key = 'opvolging.rapport.view';
