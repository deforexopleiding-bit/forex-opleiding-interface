-- 2026-09-11 — de onboardingstand op de spiegel
-- DRAAIEN OP: dfo-lms (absicpdidnoblirngiia)   ← NIET op het CRM
--
-- ⚠ LET OP BIJ HET DRAAIEN IN SUPABASE
-- Zodra er ALTER of DROP in de query staat, schuift Supabase een
-- bevestigingsvenster ertussen. Zonder die bevestiging draait er NIETS,
-- terwijl het scherm rustig blijft en er geen foutmelding komt. Controleer
-- dus na afloop met de controle-query onderaan of de kolommen er echt staan.
--
-- ── WAAROM ───────────────────────────────────────────────────────────────
-- Gemeten 11 september 2026: van de 25 spiegelrijen horen er VIJF bij een
-- onboarding met status 'afgerond'. Dat is volgens afspraak — een afgeronde
-- onboarding houdt zijn rij, zodat achteraf terug te zien is hoe lang een
-- klant erover deed. Maar de spiegel zei nergens DAT hij afgerond is, en de
-- mentorband filtert op NIETS behalve mentor_id: alles wat de policy
-- teruggeeft wordt een belopdracht. Tot vier afgeronde klanten zouden daar
-- als bellen hebben gestaan.
--
-- ── LETTERLIJK, NIET VERTAALD ────────────────────────────────────────────
-- `onboarding_stand` draagt het woord uit `onboardings.status` in het CRM
-- ONGEWIJZIGD over: aangemeld / bezig / afgerond. Geen vertaling naar
-- loopt/afgerond, geen eigen woordenlijst, geen lower(), geen trim().
--
-- Dat is met opzet, en het is de kern van het ontwerp. Komt er in het CRM een
-- status bij — on hold staat op de rol — dan ziet het LMS een woord dat het
-- niet kent en toont die rij APART met "stand onbekend, controleer in het CRM
-- voor je belt". Bij een vertaallaag zou dat nieuwe geval stilletjes in de
-- emmer 'loopt' of 'afgerond' vallen en zou niemand het merken. Onbekend moet
-- zichtbaar zijn, niet weggemapt.
--
-- Om dezelfde reden staat er GEEN CHECK-constraint op deze kolom. Een
-- woordenlijst in de databank zou precies het geval tegenhouden dat zichtbaar
-- hoort te worden: bij een nieuwe CRM-status zou de hele spiegelschrijfactie
-- falen en zou de rij verouderen in plaats van een onbekend woord te tonen.
--
-- De kolom mag LEEG zijn. Leeg betekent: het CRM had geen status staan, of de
-- spiegel heeft deze rij nog niet aangeraakt sinds de migratie. Ook dat hoort
-- het LMS als "onbekend" te behandelen — niet als "loopt".
--
-- ── afgerond_op ──────────────────────────────────────────────────────────
-- Zonder dat veld is de reden om een afgeronde rij te BEWAREN niet in te
-- lossen: `start_datum` alleen zegt niet hoe lang iemand erover deed. Komt uit
-- `onboardings.completed_at`.
--
-- SCHRIJVER. Uitsluitend api/_lib/onboarding-spiegel.js, net als de rest van
-- deze tabel. Daar staat een test op die rood wordt zodra er een tweede pad
-- bij komt.

BEGIN;

ALTER TABLE public.hlms_crm_onboarding
  ADD COLUMN IF NOT EXISTS onboarding_stand text,
  ADD COLUMN IF NOT EXISTS afgerond_op      timestamptz;

-- De mentorband vraagt "mijn studenten, met hun stand".
CREATE INDEX IF NOT EXISTS idx_hlms_crm_onboarding_mentor_stand
  ON public.hlms_crm_onboarding (mentor_id, onboarding_stand);

COMMENT ON COLUMN public.hlms_crm_onboarding.onboarding_stand IS
  'Het woord uit onboardings.status in het CRM, LETTERLIJK overgenomen: aangemeld / bezig / afgerond. Geen vertaling en geen CHECK-constraint, met opzet: komt er in het CRM een status bij (on hold staat op de rol), dan hoort het LMS die rij apart te tonen met "stand onbekend, controleer in het CRM voor je belt" in plaats van hem stilletjes bij loopt of afgerond te rekenen. Onbekend moet zichtbaar zijn, niet weggemapt. LEEG betekent hetzelfde als onbekend: het CRM had geen status, of de spiegel heeft deze rij nog niet aangeraakt sinds de migratie — behandel leeg NOOIT als "loopt". LET OP — dit is NIET hlms_student.onboarding_status. Die kolom is een bevroren Bubble-import met zeven vrije-tekstwaarden waar sinds de Bubble-uitfasering niets meer aan schrijft en waarvan niemand de betekenis nog kent. DEZE kolom staat op een andere tabel, wordt bij elke hersync door het CRM geschreven (api/_lib/onboarding-spiegel.js) en is de enige die iets zegt over de ACTUELE stand.';
COMMENT ON COLUMN public.hlms_crm_onboarding.afgerond_op IS
  'Wanneer de onboarding is afgerond (onboardings.completed_at in het CRM); NULL zolang hij loopt. Bestaat omdat een afgeronde onboarding zijn rij HOUDT: de rij verdwijnt alleen bij annuleren of archiveren. Samen met start_datum maakt dit terug te zien hoe lang een klant over zijn onboarding deed — de reden dat we de rij bewaren in plaats van weggooien.';

COMMIT;

-- ── WAT ER NOOIT IN DEZE TABEL STAAT ─────────────────────────────────────
-- 'geannuleerd' en 'gearchiveerd' komen in onboarding_stand NIET voor. Zulke
-- onboardings hebben geen spiegelrij: die wordt verwijderd. Dat is een regel
-- op drie lagen in het CRM en geen toeval — zie hoortZichtbaarTeZijn() in
-- api/_lib/onboarding-spiegel.js, de verwachte-verzameling in
-- api/_lib/onboarding-spiegel-sync.js, en de verwijder-ronde daarachter.
--
-- ── HOE DE TWEE LEZERS DIT GEBRUIKEN ─────────────────────────────────────
-- Mentorband (belopdrachten):
--     WHERE mentor_id = auth.uid() AND onboarding_stand IN ('aangemeld','bezig')
--   Bewust een TOELATINGSLIJST en geen `<> 'afgerond'`. Een toelatingslijst
--   faalt de goede kant op: een onbekend of leeg woord valt buiten de band en
--   verschijnt in het losse bakje hieronder. Bij `<> 'afgerond'` zou elk
--   nieuw of leeg woord juist ALS BELOPDRACHT op het scherm komen — en tussen
--   het draaien van deze migratie en de eerste hersync is elke rij leeg.
--
-- Apart tonen, niet bellen:
--     WHERE mentor_id = auth.uid()
--       AND (onboarding_stand IS NULL OR onboarding_stand NOT IN
--            ('aangemeld','bezig','afgerond'))
--   → "stand onbekend, controleer in het CRM voor je belt".
--
-- Hoofdmentor / terugkijken:
--   geen filter; afgerond_op - start_datum geeft de doorlooptijd.
--
-- Zo hoeft er niets weggegooid te worden om het mentorscherm rustig te houden.

-- Controle (draai dit NA de bevestiging — zie de waarschuwing bovenaan):
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'hlms_crm_onboarding'
--      AND column_name IN ('onboarding_stand', 'afgerond_op');
--   SELECT coalesce(onboarding_stand,'(leeg)') AS stand, count(*)
--     FROM public.hlms_crm_onboarding GROUP BY 1 ORDER BY 1;
--
-- Rollback:
--   ALTER TABLE public.hlms_crm_onboarding
--     DROP COLUMN IF EXISTS onboarding_stand, DROP COLUMN IF EXISTS afgerond_op;
