-- 2026-10-08 · leads.laatste_aanmelding — het moment van de laatste aanmelding.
--
-- WAAROM: upsert_lead ontdubbelt op lower(email). Meldt een bestaande lead zich
-- opnieuw aan, dan blijft leads.aangemaakt de oude datum en telde het TV-bord
-- (aangemaakt = NL-vandaag) die aanmelding niet. Met deze kolom telt het bord
-- "aangemaakt OF laatste_aanmelding = vandaag", uniek per lead.
--
-- WIE ZET DE KOLOM:
--   · nieuwe lead (elke route)            → DEFAULT now() op de INSERT (stap 3)
--   · funnels + gewoon site-formulier     → dfo-website /api/lead, na upsert_lead
--   · event-aanmeldingen (elke bron)      → trigger op event_attendees (stap 5)
--   NIET: bewerkingen in het CRM, handmatig toevoegen, opstartsessie-boekingen
--   (een geboekt gesprek is geen nieuwe aanmelding; daar is de tegel "Nieuwe
--   calls" voor). upsert_lead zelf blijft ONGEWIJZIGD.
--
-- VOLGORDE: vóór de merge van de CRM- en website-PR draaien. De code is
-- fail-soft (zonder kolom: oude telling + log), maar pas met deze migratie
-- tellen heraanmeldingen via het site-formulier en events mee.
--
-- Draaien in de Supabase SQL-editor, in deze volgorde (losse statements).
-- LET OP: stap 1 BEWUST zonder DEFAULT. Een DEFAULT now() bij het toevoegen
-- zou ALLE bestaande leads "vandaag aangemeld" maken.

-- ── 0. Vooraf (alleen lezen) ─────────────────────────────────────────────────
-- SELECT count(*) AS leads, count(*) FILTER (WHERE verwijderd_op IS NULL) AS actief FROM public.leads;
-- SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger
--  WHERE tgrelid = 'public.event_attendees'::regclass AND NOT tgisinternal;

-- ── 1. Kolom (zonder default) ────────────────────────────────────────────────
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS laatste_aanmelding timestamptz;

-- ── 2. Backfill: bestaande leads = hun aanmaakmoment ─────────────────────────
UPDATE public.leads SET laatste_aanmelding = aangemaakt WHERE laatste_aanmelding IS NULL;

-- ── 3. Default voor nieuwe rijen (pas NA de backfill) ────────────────────────
ALTER TABLE public.leads ALTER COLUMN laatste_aanmelding SET DEFAULT now();

COMMENT ON COLUMN public.leads.laatste_aanmelding IS
  'Moment van de laatste aanmelding (nieuwe lead of heraanmelding via /api/lead of een event). NIET bij CRM-bewerkingen. TV-bord telt aangemaakt OF laatste_aanmelding = vandaag.';

-- ── 4. Index voor de dag-telling ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_leads_laatste_aanmelding ON public.leads (laatste_aanmelding);

-- ── 5. Event-aanmeldingen: zelfde voorwaarden als spiegel_attendee_naar_lead ─
-- Losse trigger NAAST de bestaande spiegel-trigger (die blijft ongewijzigd):
-- bij een nieuwe event-aanmelding van een BESTAANDE lead het aanmeldmoment
-- bijwerken. Een nieuwe lead krijgt het al via de DEFAULT. Fouten breken de
-- aanmelding nooit (EXCEPTION → WARNING).
CREATE OR REPLACE FUNCTION public.markeer_lead_aanmelding_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_ev public.events;
BEGIN
  IF NEW.is_test IS TRUE THEN RETURN NEW; END IF;
  IF NEW.status = 'switched_to_other_event' THEN RETURN NEW; END IF;
  IF NEW.email IS NULL OR btrim(NEW.email) = '' THEN RETURN NEW; END IF;
  SELECT * INTO v_ev FROM public.events WHERE id = NEW.event_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF v_ev.is_historical IS TRUE OR v_ev.title ILIKE 'ZZZ-TEST%' THEN RETURN NEW; END IF;

  UPDATE public.leads SET laatste_aanmelding = now()
   WHERE lower(email) = lower(btrim(NEW.email)) AND verwijderd_op IS NULL;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[markeer_lead_aanmelding_event] overgeslagen: %', SQLERRM;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_markeer_lead_aanmelding_event ON public.event_attendees;

CREATE TRIGGER trg_markeer_lead_aanmelding_event
  AFTER INSERT ON public.event_attendees
  FOR EACH ROW EXECUTE FUNCTION public.markeer_lead_aanmelding_event();

-- ── 6. Controle (alleen lezen) ───────────────────────────────────────────────
-- Verwacht 0: geen lead zonder aanmeldmoment.
-- SELECT count(*) FROM public.leads WHERE laatste_aanmelding IS NULL;
-- Verwacht 0: backfill = aangemaakt (vóór er nieuwe aanmeldingen bij komen).
-- SELECT count(*) FROM public.leads WHERE laatste_aanmelding < aangemaakt;
-- De nieuwe trigger staat er:
-- SELECT tgname FROM pg_trigger WHERE tgname = 'trg_markeer_lead_aanmelding_event';

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- DROP TRIGGER IF EXISTS trg_markeer_lead_aanmelding_event ON public.event_attendees;
-- DROP FUNCTION IF EXISTS public.markeer_lead_aanmelding_event();
-- DROP INDEX IF EXISTS public.idx_leads_laatste_aanmelding;
-- ALTER TABLE public.leads DROP COLUMN IF EXISTS laatste_aanmelding;
-- (De code valt dan vanzelf terug op de oude telling.)
