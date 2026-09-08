-- 2026-09-07 — de onboarding-spiegel van het CRM naar het LMS
-- DRAAIEN OP: dfo-lms (absicpdidnoblirngiia)   ← NIET op het CRM
--
-- WAAROM. Het LMS kan niet bij het CRM; alleen het CRM schrijft over de
-- grens. De mentor moet in zijn eigen omgeving zien welke studenten opgepakt
-- moeten worden, met vier feiten erbij: wanneer ze starten, waar ze in de
-- wizard zitten, of de eerste factuur betaald is, en hoe de bedenktijd erbij
-- staat. Dat laatste is geen sier: de regel is dat de mentor een keer contact
-- opneemt en daarna NIET blijft bellen zolang de bedenktijd loopt.
--
-- WAAROM EEN EIGEN TABEL en geen kolommen op hlms_student:
--   1. Eigenaarschap. hlms_student is van het LMS; deze rijen zijn van het
--      CRM. Die mengen levert precies de verwarring op die `lms_provision`
--      versus `dfo_lms_*` heeft opgeleverd — twee dingen die "lms" heetten en
--      niets met elkaar te maken hadden.
--   2. Annuleren wordt een DELETE. Acht kolommen op NULL zetten laat de
--      student zichtbaar met lege vakjes; een rij weghalen is verdwijnen.
--   3. Verse-heid past er per rij op: een `bijgewerkt_op` in plaats van acht.
--
-- SCHRIJVER. Uitsluitend api/_lib/onboarding-spiegel.js. Daar staat een test
-- op die rood wordt zodra er een tweede pad bij komt.

BEGIN;

CREATE TABLE IF NOT EXISTS public.hlms_crm_onboarding (
  -- De sleutel is de ONBOARDING, niet de student: wisselt de mentor, dan
  -- verhuist dezelfde rij in plaats van dat er een tweede bij komt.
  crm_onboarding_id      uuid PRIMARY KEY,
  student_id             uuid NOT NULL REFERENCES public.hlms_student(id) ON DELETE CASCADE,
  mentor_id              uuid,

  -- De vier feiten.
  start_datum            date,
  wizard_stap            integer,
  wizard_stappen_totaal  integer,
  eerste_factuur_betaald boolean,
  bedenktijd_status      text,
  bedenktijd_vervalt_op  timestamptz,
  bedenktijd_reden       text,

  -- Leeg en niet-gelukt mogen nooit hetzelfde zijn, ook hier niet.
  bijgewerkt_op          timestamptz NOT NULL DEFAULT now(),
  bron_status            text        NOT NULL DEFAULT 'gelezen',
  bron_fout              text
);

-- Het mentorscherm vraagt "mijn studenten, op startdatum".
CREATE INDEX IF NOT EXISTS idx_hlms_crm_onboarding_mentor
  ON public.hlms_crm_onboarding (mentor_id, start_datum);
CREATE INDEX IF NOT EXISTS idx_hlms_crm_onboarding_student
  ON public.hlms_crm_onboarding (student_id);

COMMENT ON TABLE public.hlms_crm_onboarding IS
  'Spiegel van de CRM-onboarding. Geschreven door het CRM (api/_lib/onboarding-spiegel.js), read-only voor het LMS. Een rij bestaat zolang de onboarding in het CRM niet geannuleerd en niet gearchiveerd is; annuleren verwijdert de rij.';
COMMENT ON COLUMN public.hlms_crm_onboarding.wizard_stappen_totaal IS
  'Zonder totaal zegt een stapnummer niets: "stap 3" is geen stand, "3 van 7" wel.';
COMMENT ON COLUMN public.hlms_crm_onboarding.bedenktijd_status IS
  'lopend / vervallen / onbekend. LET OP: onbekend is NIET hetzelfde als vervallen — de mentor belt niet door zolang de bedenktijd loopt, dus bij onbekend geldt terughoudendheid, niet vrij spel.';
COMMENT ON COLUMN public.hlms_crm_onboarding.bijgewerkt_op IS
  'Wanneer deze rij voor het laatst door het CRM is geschreven. HOORT ZICHTBAAR TE ZIJN in het mentorscherm: een spiegel die stilstaat ziet er anders identiek uit als een spiegel die klopt.';
COMMENT ON COLUMN public.hlms_crm_onboarding.bron_status IS
  'gelezen / onbereikbaar / niet-geconfigureerd. Dezelfde woordenlijst als de sessie-lezer in het CRM; bewust geen tweede vocabulaire voor hetzelfde begrip.';

COMMIT;

-- ── De dode Bubble-kolom markeren (GEEN hernoeming) ────────────────────────
-- hlms_student.onboarding_status is een bevroren Bubble-import: zeven vrije-
-- tekstwaarden over 307 rijen, half NL half EN, en er schrijft niets meer aan.
-- Hij wordt WEL nog gelezen: src/features/admin/hlms-student-detail-page.tsx
-- toont 'm als "Onboarding-status", en own-hlms-student-store.tsx laadt 'm in
-- de state van het eigen studentprofiel. Hernoemen breekt die schermen, dus
-- dat gebeurt pas in de LMS-PR die ze omzet. Tot die tijd alleen een bordje.
COMMENT ON COLUMN public.hlms_student.onboarding_status IS
  'BEVROREN Bubble-import (7 vrije-tekstwaarden, half NL/EN). Er schrijft sinds de Bubble-uitfasering NIETS meer aan; de waarden zijn niet gedefinieerd en niemand weet nog wat "Niet alles klaar" betekende. De ACTUELE onboarding-stand komt uit het CRM en staat in hlms_crm_onboarding. Niet gebruiken voor nieuwe logica.';

-- Controle:
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name = 'hlms_crm_onboarding' ORDER BY ordinal_position;
--
-- Rollback:
--   DROP TABLE IF EXISTS public.hlms_crm_onboarding;
