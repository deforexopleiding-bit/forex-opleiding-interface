-- ============================================================================
-- LEAD-DEDUP — DOC 2 / RPC + INDEX + TRIGGER (draai NA DOC 1)
-- ============================================================================
-- Alles in ÉÉN transactie, zodat er geen venster is waarin de oude trigger op
-- de gedropte index draait. Bevat:
--   1. upsert_lead(p jsonb)  — de centrale schrijf-functie (veldbeleid hieronder)
--   2. index-swap: DROP leads_event_uniek -> CREATE UNIQUE leads_email_uniek
--   3. herschrijf spiegel_attendee_naar_lead -> PERFORM upsert_lead(...)
--
-- VELDBELEID upsert_lead (ON CONFLICT (lower(email)) DO UPDATE):
--   - Nieuwste wint            : traject, event_id, soort, bron, bijgewerkt=now()
--   - COALESCE(EXCLUDED, oud)  : voornaam, achternaam, telefoon, telefoon_e164,
--                                score, kwalificatie, drempel, afwijzer,
--                                antwoorden, campagne, pagina
--   - Sticky consent           : toestemming = oud.toestemming OR EXCLUDED.toestemming
--   - NIET overschrijven       : eigenaar_id, notitie, status, aangemaakt, customer_id
--
-- Type-veiligheid: jsonb_populate_record(NULL::public.leads, p) mapt de jsonb-
-- keys op de ECHTE kolomtypen van leads, dus geen handmatige casts nodig.
--
-- Jeffrey draait dit. Niets wordt automatisch gedraaid.
-- ============================================================================

-- STAP 0 — DUMP de huidige objecten (verzoen de skip-checks + index-naam hiermee):
--   SELECT pg_get_functiondef('public.spiegel_attendee_naar_lead'::regproc);
--   SELECT indexname, indexdef FROM pg_indexes
--   WHERE schemaname='public' AND tablename='leads';


BEGIN;

-- ── 1) Centrale upsert ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.upsert_lead(p jsonb)
RETURNS public.leads
LANGUAGE plpgsql
AS $$
DECLARE
  v_in  public.leads;   -- type-veilig gevuld uit p (echte kolomtypen)
  v_out public.leads;
BEGIN
  v_in := jsonb_populate_record(NULL::public.leads, p);
  v_in.email := lower(v_in.email);
  IF v_in.email IS NULL OR btrim(v_in.email) = '' THEN
    RAISE EXCEPTION 'upsert_lead: lege email';
  END IF;

  -- INSERT: NOT NULL-kolommen krijgen een default als p ze weglaat. In de
  -- DO UPDATE gebruiken we bewust v_in.* (de ORIGINELE input, null-als-weggelaten)
  -- i.p.v. EXCLUDED.*, zodat COALESCE-behoud óók klopt voor die NOT NULL-kolommen
  -- (EXCLUDED zou de default tonen en zo bestaande waarden overschrijven).
  INSERT INTO public.leads AS l (
    email, voornaam, achternaam, telefoon, telefoon_e164,
    bron, soort, campagne, pagina, traject, kwalificatie, score, drempel,
    afwijzer, antwoorden, event_id, toestemming, status, bijgewerkt
  ) VALUES (
    v_in.email, v_in.voornaam, v_in.achternaam, v_in.telefoon, v_in.telefoon_e164,
    v_in.bron, v_in.soort, v_in.campagne, v_in.pagina, v_in.traject, v_in.kwalificatie, v_in.score, v_in.drempel,
    COALESCE(v_in.afwijzer, false), COALESCE(v_in.antwoorden, '[]'::jsonb), v_in.event_id,
    COALESCE(v_in.toestemming, false), COALESCE(v_in.status, 'nieuw'), now()
  )
  ON CONFLICT (lower(email)) DO UPDATE SET
    -- interactie-definitie: nieuwste wint
    traject   = v_in.traject,
    event_id  = v_in.event_id,
    soort     = v_in.soort,
    bron      = v_in.bron,
    -- interactie-data: nieuwste NON-NULL wint (wist niets)
    voornaam      = COALESCE(v_in.voornaam,      l.voornaam),
    achternaam    = COALESCE(v_in.achternaam,    l.achternaam),
    telefoon      = COALESCE(v_in.telefoon,      l.telefoon),
    telefoon_e164 = COALESCE(v_in.telefoon_e164, l.telefoon_e164),
    score         = COALESCE(v_in.score,         l.score),
    kwalificatie  = COALESCE(v_in.kwalificatie,  l.kwalificatie),
    drempel       = COALESCE(v_in.drempel,       l.drempel),
    afwijzer      = COALESCE(v_in.afwijzer,      l.afwijzer),
    antwoorden    = COALESCE(v_in.antwoorden,    l.antwoorden),
    campagne      = COALESCE(v_in.campagne,      l.campagne),
    pagina        = COALESCE(v_in.pagina,        l.pagina),
    -- consent sticky, nooit downgraden
    toestemming   = COALESCE(l.toestemming, false) OR COALESCE(v_in.toestemming, false),
    -- altijd bijwerken
    bijgewerkt    = now()
    -- NIET in de SET (bewust behouden): eigenaar_id, notitie, status, aangemaakt, customer_id
  RETURNING l.* INTO v_out;

  RETURN v_out;
END $$;


-- ── 2) Index-swap: partiële event-index eruit, unieke email-index erin ───────
DROP INDEX IF EXISTS public.leads_event_uniek;
CREATE UNIQUE INDEX leads_email_uniek ON public.leads (lower(email));


-- ── 3) Mirror-trigger: schrijf via upsert_lead i.p.v. eigen INSERT ──────────
-- BELANGRIJK: neem de skip-checks hieronder EXACT over uit de STAP 0-dump van
-- de huidige functie (is_test / switched / lege email / historical-ZZZ). De
-- guards hieronder zijn een template — vervang ze door je bestaande condities.
CREATE OR REPLACE FUNCTION public.spiegel_attendee_naar_lead()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- ── SKIP-CHECKS (verzoen met STAP 0-dump) ──────────────────────────────
  -- lege email
  IF NEW.email IS NULL OR btrim(NEW.email) = '' THEN
    RETURN NEW;
  END IF;
  -- test-attendees
  IF COALESCE(NEW.is_test, false) THEN
    RETURN NEW;
  END IF;
  -- switch-created rijen (geen tweede lead bij een datum-switch)
  IF NEW.switched_from_event_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  -- historical/ZZZ-import  <<< VERVANG door je bestaande conditie uit STAP 0
  -- IF <historical/ZZZ conditie> THEN RETURN NEW; END IF;

  -- ── Schrijf via de centrale upsert (i.p.v. eigen INSERT ON CONFLICT) ───
  PERFORM public.upsert_lead(jsonb_build_object(
    'email',      NEW.email,
    'voornaam',   NEW.first_name,
    'achternaam', NEW.last_name,
    'telefoon',   NEW.phone,
    'traject',    'event',
    'bron',       'event',
    'soort',      'event',
    'event_id',   NEW.event_id
  ));

  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  -- Fail-safe: een fout in de lead-spiegeling mag de attendee-insert NOOIT
  -- breken (behoud van het bestaande gedrag).
  RAISE WARNING '[spiegel_attendee_naar_lead] overgeslagen: %', SQLERRM;
  RETURN NEW;
END $$;
-- De bestaande CREATE TRIGGER-binding blijft geldig (we vervangen alleen de
-- functie). Controleer met STAP 0 dat de trigger inderdaad deze functie
-- aanroept en op AFTER INSERT (evt. OR UPDATE) staat.

COMMIT;


-- STAP 4 — CONTROLE (na COMMIT): unieke index aanwezig?
SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname='public' AND tablename='leads' AND indexname='leads_email_uniek';
