-- ============================================================================
-- LEADS — Feature 2 (soort => herkomst) + Feature 3 (soft-delete) — GEDEELDE MIGRATIE
-- ============================================================================
-- Draai NA de dedup-migratie (leads_email_uniek + upsert_lead bestaan al live).
-- Jeffrey draait; niets automatisch. Draai het HELE bestand in één keer.
-- Geen temp tables → geen DOC-1-achtige editor-issues. DO $$-blokken alleen waar
-- meerdere statements samen moeten. CREATE OR REPLACE / ALTER zijn los top-level.
--
-- Volgorde is bewust: kolommen (3A) VÓÓR upsert_lead (die verwijst ernaar);
-- view-update NA de kolommen.
-- ============================================================================


-- ── STAP 0 — DUMPS ter reconciliatie (informatief) ──────────────────────────
-- (a) de leads_overzicht-view is Supabase-only; dump 'm zodat je in FEATURE 3B
--     alleen 'verwijderd_op' aan de bestaande SELECT-lijst toevoegt:
--   SELECT pg_get_viewdef('public.leads_overzicht'::regclass, true);
-- (b) bevestig dat upsert_lead nu de live dedup-versie is:
--   SELECT pg_get_functiondef('public.upsert_lead'::regproc);


-- ============================================================================
-- FEATURE 3A — soft-delete-kolommen
-- ============================================================================
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS verwijderd_op   timestamptz,
  ADD COLUMN IF NOT EXISTS verwijderd_door uuid;


-- ============================================================================
-- FEATURE 2B — backfill: oude, redundante soort-waarde -> 'onbekend'
-- ============================================================================
-- Idempotent: laat echte herkomst-slugs en reeds-'onbekend' met rust.
UPDATE public.leads
SET soort = 'onbekend'
WHERE soort IS DISTINCT FROM 'onbekend'
  AND soort NOT IN ('instagram','facebook','google','via-via','linkedin','tiktok','overige');


-- ============================================================================
-- FEATURE 2B + 3A — upsert_lead herschrijven
-- ============================================================================
-- Wijzigingen t.o.v. de dedup-versie:
--   * INSERT : soort = COALESCE(v_in.soort,'onbekend'); bron = COALESCE(v_in.bron,'website')
--              (soort is NOT NULL — een event-only lead zonder herkomst mag niet crashen)
--   * DO UPDATE: soort/bron/traject/event_id nu COALESCE(v_in, l) i.p.v. altijd v_in,
--              zodat een event-aanmelding (die geen soort meestuurt) de herkomst
--              uit de vragenlijst NIET wist.
--   * DO UPDATE: verwijderd_op = NULL + verwijderd_door = NULL  (revive: een
--              gearchiveerde lead die zich opnieuw aanmeldt komt automatisch terug,
--              zodat unique(lower(email)) heel blijft en "één lead per persoon" klopt).
-- De rest van de merge-logica (interactie-data COALESCE, attributie/consent
-- behoud, afwijzer, sticky consent) is ONGEWIJZIGD.
CREATE OR REPLACE FUNCTION public.upsert_lead(p jsonb)
RETURNS public.leads
LANGUAGE plpgsql
AS $$
DECLARE
  v_in  public.leads;
  v_out public.leads;
BEGIN
  v_in := jsonb_populate_record(NULL::public.leads, p);
  v_in.email := lower(v_in.email);
  IF v_in.email IS NULL OR btrim(v_in.email) = '' THEN
    RAISE EXCEPTION 'upsert_lead: lege email';
  END IF;

  INSERT INTO public.leads AS l (
    email, voornaam, achternaam, telefoon, telefoon_e164,
    bron, soort, campagne, pagina, traject, kwalificatie, score, drempel,
    afwijzer, antwoorden, event_id, meta_event_id, ip_hash,
    toestemming, toestemming_op, status, bijgewerkt
  ) VALUES (
    v_in.email, v_in.voornaam, v_in.achternaam, v_in.telefoon, v_in.telefoon_e164,
    COALESCE(v_in.bron, 'website'), COALESCE(v_in.soort, 'onbekend'), v_in.campagne, v_in.pagina, v_in.traject, v_in.kwalificatie, v_in.score, v_in.drempel,
    COALESCE(v_in.afwijzer, false), COALESCE(v_in.antwoorden, '[]'::jsonb), v_in.event_id, v_in.meta_event_id, v_in.ip_hash,
    COALESCE(v_in.toestemming, false), v_in.toestemming_op, COALESCE(v_in.status, 'nieuw'), now()
  )
  ON CONFLICT (lower(email)) DO UPDATE SET
    -- interactie-definitie: COALESCE-guard (interactie zonder waarde wist niets;
    -- event-aanmelding stuurt geen soort -> herkomst blijft behouden)
    traject   = COALESCE(v_in.traject,  l.traject),
    event_id  = COALESCE(v_in.event_id, l.event_id),
    soort     = COALESCE(v_in.soort,    l.soort),
    bron      = COALESCE(v_in.bron,     l.bron),
    -- interactie-data: nieuwste NON-NULL wint (wist niets)
    voornaam      = COALESCE(v_in.voornaam,      l.voornaam),
    achternaam    = COALESCE(v_in.achternaam,    l.achternaam),
    telefoon      = COALESCE(v_in.telefoon,      l.telefoon),
    telefoon_e164 = COALESCE(v_in.telefoon_e164, l.telefoon_e164),
    score         = COALESCE(v_in.score,         l.score),
    kwalificatie  = COALESCE(v_in.kwalificatie,  l.kwalificatie),
    drempel       = COALESCE(v_in.drempel,       l.drempel),
    antwoorden    = COALESCE(v_in.antwoorden,    l.antwoorden),
    campagne      = COALESCE(v_in.campagne,      l.campagne),
    pagina        = COALESCE(v_in.pagina,        l.pagina),
    afwijzer      = COALESCE(v_in.afwijzer,      l.afwijzer),
    -- attributie/consent: eerste waarde behouden; consent sticky
    meta_event_id  = COALESCE(l.meta_event_id,  v_in.meta_event_id),
    ip_hash        = COALESCE(l.ip_hash,        v_in.ip_hash),
    toestemming    = COALESCE(l.toestemming, false) OR COALESCE(v_in.toestemming, false),
    toestemming_op = COALESCE(l.toestemming_op, v_in.toestemming_op),
    -- revive uit het archief bij elke nieuwe interactie
    verwijderd_op   = NULL,
    verwijderd_door = NULL,
    -- altijd bijwerken
    bijgewerkt    = now()
    -- NIET in de SET (behouden): eigenaar_id, notitie, status, opgevolgd_op, customer_id, aangemaakt
  RETURNING l.* INTO v_out;

  RETURN v_out;
END $$;


-- ============================================================================
-- FEATURE 2B — mirror-trigger: 'soort' NIET meer meesturen
-- ============================================================================
-- Alleen de payload verandert (soort eruit). Skip-checks + SECURITY DEFINER +
-- search_path + EXCEPTION ONGEWIJZIGD. Via de COALESCE-guard in upsert_lead laat
-- een event-aanmelding de herkomst (soort) met rust. traject/bron/event_id blijven.
CREATE OR REPLACE FUNCTION public.spiegel_attendee_naar_lead()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ev public.events;
BEGIN
  IF NEW.is_test IS TRUE THEN RETURN NEW; END IF;
  IF NEW.status = 'switched_to_other_event' THEN RETURN NEW; END IF;
  IF NEW.email IS NULL OR btrim(NEW.email) = '' THEN RETURN NEW; END IF;

  SELECT * INTO v_ev FROM public.events WHERE id = NEW.event_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF v_ev.is_historical IS TRUE OR v_ev.title ILIKE 'ZZZ-TEST%' THEN RETURN NEW; END IF;

  PERFORM public.upsert_lead(jsonb_build_object(
    'email',      NEW.email,
    'voornaam',   NEW.first_name,
    'achternaam', NEW.last_name,
    'telefoon',   NEW.phone,
    'traject',    'event',
    'bron',       'event',
    'event_id',   NEW.event_id
    -- 'soort' BEWUST WEG: laat de herkomst uit de vragenlijst ongemoeid
  ));

  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[spiegel_attendee_naar_lead] overgeslagen: %', SQLERRM;
  RETURN NEW;
END $$;


-- ============================================================================
-- FEATURE 3B — leads_overzicht-view: verwijderd_op exposen (voor de list-filter)
-- ============================================================================
-- De view is Supabase-only. Draai STAP 0(a) hierboven, en voeg in de bestaande
-- definitie ALLEEN 'verwijderd_op' (en evt. 'verwijderd_door') aan de SELECT-lijst
-- toe — verander verder NIETS aan de kolommen/joins/filters. Voorbeeldvorm
-- (reconcilieer met je dump; l = de leads-alias in de view):
--
--   CREATE OR REPLACE VIEW public.leads_overzicht AS
--   SELECT
--     <... alle bestaande kolommen exact zoals in de dump ...>,
--     l.verwijderd_op,
--     l.verwijderd_door
--   FROM public.leads l
--   <... bestaande joins/where exact zoals in de dump ...>;
--
-- NB: de API filtert zelf met .is('verwijderd_op', null); de view moet 'm alleen
-- LEVEREN (de view zelf NIET filteren, anders kan de Gearchiveerd-tab ze niet tonen).


-- ============================================================================
-- FEATURE 3C — RBAC: permissie 'leads.delete' (admin + super_admin-wildcard)
-- ============================================================================
-- Mirror van docs/sql-migrations/2026-07-28-leads-rbac.sql. super_admin heeft
-- geen grant nodig (wildcard in user_has_permission). Voeg admin (+ desgewenst
-- manager) toe. Idempotent.
INSERT INTO public.role_permissions (role, feature_key, allowed) VALUES
  ('admin',   'leads.delete', true),
  ('manager', 'leads.delete', true)
ON CONFLICT (role, feature_key) DO UPDATE SET allowed = EXCLUDED.allowed;


-- ============================================================================
-- CONTROLES (na afloop)
-- ============================================================================
-- kolommen aanwezig?
SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='leads'
  AND column_name IN ('verwijderd_op','verwijderd_door');

-- soort-verdeling na backfill:
SELECT soort, count(*) FROM public.leads GROUP BY soort ORDER BY 2 DESC;

-- view levert de kolom?
SELECT verwijderd_op FROM public.leads_overzicht LIMIT 1;

-- permissie gezet?
SELECT role, feature_key, allowed FROM public.role_permissions WHERE feature_key='leads.delete';
