-- ============================================================================
-- leads.telefoon_e164 — nooit meer uit de pas met leads.telefoon
-- Datum: 28 september 2026
-- PR: fix telefoonnummers (leads.telefoon_e164 + opvolging) niet meer stil naar +31
--
-- ⚠ MET DE HAND DRAAIEN in de Supabase SQL-editor, NA review. Niet blokkerend:
-- de code noemt niets uit dit bestand bij naam, dus zonder deze migratie
-- faalt er niets — dan blijft alleen het gat hieronder open.
--
-- ── WAT ER MISGING ──────────────────────────────────────────────────────────
-- upsert_lead normaliseert niets. Op een nieuwe rij schrijft hij telefoon en
-- telefoon_e164 letterlijk weg; bij ON CONFLICT (lower(email)) doet hij
--   telefoon      = COALESCE(v_in.telefoon,      l.telefoon)
--   telefoon_e164 = COALESCE(v_in.telefoon_e164, l.telefoon_e164)
-- Een aanroep met een NIEUW telefoonnummer maar ZONDER telefoon_e164 — de
-- trigger spiegel_attendee_naar_lead geeft alleen 'telefoon' => NEW.phone mee
-- — overschrijft dus telefoon en laat de oude (foute) telefoon_e164 staan.
-- Elias Vieren: telefoon '+32…', telefoon_e164 '+31…'. De werklijst belt met
-- telefoon_e164. En een nieuwe lead via die trigger krijgt telefoon_e164 NULL.
--
-- ── WAT DIT DOET ────────────────────────────────────────────────────────────
-- 1. public.normaliseer_nl_be(text) — SPIEGEL van normaliseerNlBe in
--    api/_lib/phone-e164.js (zonder het landveld; dat heeft de database niet).
--    Geeft het E.164-nummer, of bij twijfel het rauwe (getrimde) nummer, of
--    NULL bij geen nummer. tests/telefoon-nl-be.test.js leest de
--    controlegevallen onderaan dit bestand en houdt ze gelijk met de JS.
-- 2. Een BEFORE INSERT OR UPDATE-trigger op public.leads die telefoon_e164
--    afleidt uit telefoon, ALLEEN als de schrijver hem niet zelf zet:
--      INSERT: telefoon_e164 IS NULL en telefoon gevuld;
--      UPDATE: telefoon verandert én telefoon_e164 blijft gelijk aan de oude
--              waarde (precies de COALESCE-tak van upsert_lead).
--    Wie telefoon_e164 zelf meegeeft (alle API-routes en dfo-website) wint.
--
-- WAAROM EEN TRIGGER EN NIET upsert_lead HERSCHRIJVEN: de trigger hoeft de
-- body van upsert_lead niet te kennen of te vervangen, dekt zowel de insert-
-- als de conflict-tak, en ook elke andere schrijver (een UPDATE vanuit de
-- SQL-editor, een toekomstige RPC). upsert_lead blijft ongewijzigd.
--
-- ── WAT DIT NIET DOET ───────────────────────────────────────────────────────
-- Er wordt GEEN bestaande rij aangeraakt. Een rij verandert pas als er een
-- nieuwe INSERT of een UPDATE op telefoon komt. Controle: stap A vóór en
-- stap C na het draaien moeten dezelfde uitkomst geven.
--
-- ── VOLGORDE IN DE SQL-EDITOR ───────────────────────────────────────────────
-- A. Controlequery (onderaan, 'VÓÓR') — noteer de uitkomst.
-- B. Dit bestand tot en met de CREATE TRIGGER.
-- C. Controlequery nogmaals — moet gelijk zijn aan A.
-- D. De controlegevallen (onderaan) — elke rij moet ok = true geven.
--
-- ── TERUGDRAAIEN ────────────────────────────────────────────────────────────
--   DROP TRIGGER IF EXISTS leads_telefoon_e164_afleiden ON public.leads;
--   DROP FUNCTION IF EXISTS public.leads_telefoon_e164_afleiden();
--   DROP FUNCTION IF EXISTS public.normaliseer_nl_be(text);
-- ============================================================================


-- ── 1 · De normalisatie ─────────────────────────────────────────────────────
-- Regels (zie de kop van normaliseerNlBe voor het waarom):
--   + of 00          → landcode wint; bij +31/+32 een trunk-nul eraf en de
--                      lengte controleren (+31: 9; +32: 8, of 9 met een 4)
--   31…/32… zonder + → alleen als het nationale deel daarna exact klopt
--   9 cijfers, geen 0: 45x-49x → +32 (BE gsm), 6x → +31 (NL gsm)
--   0 + 9 cijfers    : 045-049 → +32, 06 → +31, overig → +31 (NL vast)
--   0 + 8 cijfers    : → +32 (BE vast)
--   anders           : het rauwe nummer terug (niet gokken)
CREATE OR REPLACE FUNCTION public.normaliseer_nl_be(p_raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_rauw text;
  v_s    text;
  v_d    text;
  v_nat  text;
  v_code text;
BEGIN
  IF p_raw IS NULL THEN RETURN NULL; END IF;
  v_rauw := btrim(p_raw);
  v_s := regexp_replace(v_rauw, '[[:space:]()./-]', '', 'g');
  IF v_s = '' THEN RETURN NULL; END IF;

  -- + of 00: de landcode staat er al.
  IF left(v_s, 1) = '+' OR left(v_s, 2) = '00' THEN
    v_d := CASE WHEN left(v_s, 1) = '+' THEN substr(v_s, 2) ELSE substr(v_s, 3) END;
    IF v_d !~ '^[0-9]+$' OR left(v_d, 1) = '0' THEN RETURN v_rauw; END IF;
    FOREACH v_code IN ARRAY ARRAY['31', '32'] LOOP
      IF left(v_d, 2) = v_code THEN
        v_nat := regexp_replace(substr(v_d, 3), '^0', '');
        IF (v_code = '31' AND length(v_nat) = 9)
           OR (v_code = '32' AND (length(v_nat) = 8 OR (length(v_nat) = 9 AND left(v_nat, 1) = '4'))) THEN
          RETURN '+' || v_code || v_nat;
        END IF;
        RETURN v_rauw;
      END IF;
    END LOOP;
    IF ('+' || v_d) ~ '^\+[1-9][0-9]{7,14}$' THEN RETURN '+' || v_d; END IF;
    RETURN v_rauw;
  END IF;

  IF v_s !~ '^[0-9]+$' THEN RETURN v_rauw; END IF;

  -- Geen 0 ervoor: landcode zonder +, of een nationaal gsm zonder 0.
  IF left(v_s, 1) <> '0' THEN
    FOREACH v_code IN ARRAY ARRAY['31', '32'] LOOP
      IF left(v_s, 2) = v_code THEN
        v_nat := regexp_replace(substr(v_s, 3), '^0', '');
        IF (v_code = '31' AND length(v_nat) = 9)
           OR (v_code = '32' AND (length(v_nat) = 8 OR (length(v_nat) = 9 AND left(v_nat, 1) = '4'))) THEN
          RETURN '+' || v_code || v_nat;
        END IF;
      END IF;
    END LOOP;
    IF length(v_s) = 9 AND v_s ~ '^4[5-9]' THEN RETURN '+32' || v_s; END IF;
    IF length(v_s) = 9 AND left(v_s, 1) = '6' THEN RETURN '+31' || v_s; END IF;
    RETURN v_rauw;
  END IF;

  -- Lokaal met 0.
  v_nat := substr(v_s, 2);
  IF left(v_nat, 1) = '0' THEN RETURN v_rauw; END IF;
  IF length(v_nat) = 9 AND v_nat ~ '^4[5-9]' THEN RETURN '+32' || v_nat; END IF;
  IF length(v_nat) = 9 THEN RETURN '+31' || v_nat; END IF;   -- 06 + NL vast
  IF length(v_nat) = 8 THEN RETURN '+32' || v_nat; END IF;   -- BE vast
  RETURN v_rauw;
END
$function$;

COMMENT ON FUNCTION public.normaliseer_nl_be(text) IS
  'Spiegel van normaliseerNlBe (api/_lib/phone-e164.js): NL/BE-nummer naar E.164, bij twijfel het rauwe nummer. Zie docs/sql-migrations/2026-09-28-leads-telefoon-e164-normaliseren.sql.';


-- ── 2 · De trigger ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.leads_telefoon_e164_afleiden()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_nieuw text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.telefoon_e164 IS NOT NULL OR NEW.telefoon IS NULL OR btrim(NEW.telefoon) = '' THEN
      RETURN NEW;
    END IF;
  ELSE
    -- Alleen als telefoon verandert en de schrijver telefoon_e164 NIET zelf
    -- aanpast: dat is de COALESCE-tak van upsert_lead.
    IF NEW.telefoon IS NOT DISTINCT FROM OLD.telefoon
       OR NEW.telefoon_e164 IS DISTINCT FROM OLD.telefoon_e164 THEN
      RETURN NEW;
    END IF;
  END IF;

  v_nieuw := public.normaliseer_nl_be(NEW.telefoon);
  IF v_nieuw IS NOT NULL AND v_nieuw !~ '^\+[1-9][0-9]{7,14}$' THEN
    -- Twijfel: rauw bewaren (zichtbaar in de lijst), niet gokken.
    RAISE LOG '[leads_telefoon_e164_afleiden] niet omgezet, rauw bewaard: lead % telefoon %', NEW.id, NEW.telefoon;
  END IF;
  NEW.telefoon_e164 := v_nieuw;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS leads_telefoon_e164_afleiden ON public.leads;
CREATE TRIGGER leads_telefoon_e164_afleiden
  BEFORE INSERT OR UPDATE OF telefoon, telefoon_e164 ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.leads_telefoon_e164_afleiden();


-- ============================================================================
-- CONTROLEQUERY — draai VÓÓR (stap A) en NA (stap C). Moet gelijk zijn.
-- Een vingerafdruk over alle telefoonvelden: verandert er één rij, dan
-- verandert de md5.
-- ============================================================================
-- SELECT count(*)                                              AS leads,
--        count(telefoon_e164)                                  AS met_e164,
--        md5(string_agg(id::text || '|' || coalesce(telefoon, '') || '|'
--                       || coalesce(telefoon_e164, ''), ',' ORDER BY id)) AS vingerafdruk
-- FROM public.leads;


-- ============================================================================
-- CONTROLEGEVALLEN (stap D) — alleen lezen, raakt geen data. Elke rij ok = true.
-- tests/telefoon-nl-be.test.js leest deze lijst en controleert dat
-- normaliseerNlBe precies dezelfde uitkomst geeft; wie hier een geval toevoegt,
-- test daarmee ook de JS.
-- ============================================================================
-- CONTROLEGEVALLEN-BEGIN
SELECT invoer, verwacht, public.normaliseer_nl_be(invoer) AS uitkomst,
       public.normaliseer_nl_be(invoer) IS NOT DISTINCT FROM verwacht AS ok
FROM (VALUES
  ('0475716706',        '+32475716706'),
  ('0625585610',        '+31625585610'),
  ('+31 6 22947174',    '+31622947174'),
  ('0476464399',        '+32476464399'),
  ('+32 471 48 58 16',  '+32471485816'),
  ('3147979884',        '3147979884'),
  ('+3147979884',       '+3147979884'),
  ('093123456',         '+3293123456'),
  ('+32470085329',      '+32470085329'),
  ('0032471134787',     '+32471134787'),
  ('00310633298551',    '+31633298551'),
  ('+310682610365',     '+31682610365'),
  ('31 0612348963',     '+31612348963'),
  ('470497423',         '+32470497423'),
  ('465705330',         '+32465705330'),
  ('612345678',         '+31612345678'),
  ('+31475716706',      '+31475716706'),
  ('0402123456',        '+31402123456'),
  ('0201234567',        '+31201234567'),
  ('02 123 45 67',      '+3221234567'),
  ('0495/12.34.56',     '+32495123456'),
  ('+32 0478 12 34 56', '+32478123456'),
  ('+32123456789',      '+32123456789'),
  ('+4915112345678',    '+4915112345678'),
  ('06-1234',           '06-1234'),
  ('04757167061',       '04757167061'),
  ('201234567',         '201234567'),
  ('',                  NULL)
) AS t(invoer, verwacht);
-- CONTROLEGEVALLEN-EINDE
