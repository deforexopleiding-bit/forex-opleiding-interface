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
-- klant erover deed. Maar de spiegel zegt nergens DAT hij afgerond is, en de
-- mentorband gaat vandaag live met precies dat onderscheid als bestaansreden.
-- Zonder deze kolom ziet de mentor vijf afgeronde studenten tussen zijn
-- lopende staan, en is er geen manier om ze eruit te filteren.
--
-- ── TWEE KOLOMMEN, ÉÉN DOEL ──────────────────────────────────────────────
-- `crm_stand`   — waar de onboarding staat, uit een vaste woordenlijst.
-- `afgerond_op` — wanneer hij is afgerond. Zonder dat tweede veld is de reden
--                 om de rij te bewaren niet in te lossen: `start_datum` alleen
--                 zegt niet hoe lang iemand erover deed.
--
-- ── WAAROM crm_stand EN NIET onboarding_stand ────────────────────────────
-- Er staat op hlms_student al een BEVROREN Bubble-kolom `onboarding_status`.
-- Twee velden met bijna dezelfde naam en een andere betekenis is precies hoe
-- we een dag kwijt zijn geraakt aan `lms_provision` tegenover `dfo_lms`. Het
-- voorvoegsel `crm_` zegt waar de waarde vandaan komt en wie hem schrijft.
--
-- SCHRIJVER. Uitsluitend api/_lib/onboarding-spiegel.js, net als de rest van
-- deze tabel. Daar staat een test op die rood wordt zodra er een tweede pad
-- bij komt.

BEGIN;

ALTER TABLE public.hlms_crm_onboarding
  ADD COLUMN IF NOT EXISTS crm_stand   text NOT NULL DEFAULT 'onbekend',
  ADD COLUMN IF NOT EXISTS afgerond_op timestamptz;

-- De woordenlijst. 'geannuleerd' en 'gearchiveerd' staan er met opzet NIET
-- in: zulke onboardings hebben geen spiegelrij meer, die worden verwijderd.
-- 'onbekend' hoort er WEL in — een CRM-status die wij nog niet kennen mag de
-- hele spiegelrij niet laten mislukken. Liever een zichtbaar 'onbekend' dan
-- een rij die er niet is.
ALTER TABLE public.hlms_crm_onboarding
  DROP CONSTRAINT IF EXISTS hlms_crm_onboarding_crm_stand_check;
ALTER TABLE public.hlms_crm_onboarding
  ADD CONSTRAINT hlms_crm_onboarding_crm_stand_check
  CHECK (crm_stand IN ('aangemeld', 'bezig', 'afgerond', 'onbekend'));

-- De mentorband vraagt "mijn studenten die nog lopen".
CREATE INDEX IF NOT EXISTS idx_hlms_crm_onboarding_mentor_stand
  ON public.hlms_crm_onboarding (mentor_id, crm_stand);

COMMENT ON COLUMN public.hlms_crm_onboarding.crm_stand IS
  'Waar de onboarding in het CRM staat: aangemeld / bezig / afgerond / onbekend. LET OP — dit is NIET hlms_student.onboarding_status. Die kolom is een bevroren Bubble-import met zeven vrije-tekstwaarden waar sinds de Bubble-uitfasering niets meer aan schrijft en waarvan niemand de betekenis nog kent. DEZE kolom is een vaste woordenlijst, wordt bij elke hersync door het CRM geschreven (api/_lib/onboarding-spiegel.js) en is de enige die iets zegt over de ACTUELE stand. Gebruik voor nieuwe logica uitsluitend deze. Twee velden met bijna dezelfde naam en een andere betekenis is hoe we eerder een dag kwijt zijn geraakt aan lms_provision tegenover dfo_lms.';
COMMENT ON COLUMN public.hlms_crm_onboarding.afgerond_op IS
  'Wanneer de onboarding is afgerond (onboardings.completed_at in het CRM); NULL zolang hij loopt. Bestaat omdat een afgeronde onboarding zijn rij HOUDT: de rij verdwijnt alleen bij annuleren of archiveren. Samen met start_datum maakt dit terug te zien hoe lang een klant over zijn onboarding deed — de reden dat we de rij bewaren in plaats van weggooien.';

COMMIT;

-- ── HOE DE TWEE LEZERS DIT GEBRUIKEN ─────────────────────────────────────
-- Mentorband (lopend werk):   WHERE mentor_id = auth.uid() AND crm_stand <> 'afgerond'
-- Hoofdmentor / terugkijken:  geen filter op crm_stand; afgerond_op - start_datum
--                             geeft de doorlooptijd.
-- Zo hoeft er niets weggegooid te worden om het mentorscherm rustig te houden.

-- Controle (draai dit NA de bevestiging — zie de waarschuwing bovenaan):
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_name = 'hlms_crm_onboarding'
--      AND column_name IN ('crm_stand', 'afgerond_op');
--   SELECT crm_stand, count(*) FROM public.hlms_crm_onboarding GROUP BY 1 ORDER BY 1;
--
-- Rollback:
--   ALTER TABLE public.hlms_crm_onboarding
--     DROP COLUMN IF EXISTS crm_stand, DROP COLUMN IF EXISTS afgerond_op;
