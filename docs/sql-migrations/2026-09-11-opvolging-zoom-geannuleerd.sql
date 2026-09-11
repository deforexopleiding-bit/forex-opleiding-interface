-- 2026-09-11 · reden 'zoom_geannuleerd' op opvolging_taken
-- ============================================================================
--
-- ⚠ BLOKKEREND. Draai dit VÓÓR of DIRECT NA de merge van de PR die
--   api/cron-opvolging-annuleringen.js toevoegt.
--
--   Zonder deze migratie faalt ELKE kaart die die cron aanmaakt met
--   `violates check constraint "opvolging_taken_reden_chk"`, en blijft een
--   geannuleerde zoomcall precies zo onzichtbaar als hij nu is. De cron logt
--   dat per afspraak (elke insert zit in een eigen try/catch) en zet het in
--   `summary.errors`, dus er crasht niets — de functie werkt alleen niet.
--
-- ── WAAROM EEN NIEUWE REDEN ───────────────────────────────────────────────
-- De kaarten van cron-opvolging-annuleringen zeggen: 'deze zoomcall is
-- afgezegd en er staat niets nieuws, plan hem opnieuw in'. Dat is geen van de
-- bestaande redenen. Het is geen no-show (de call is niet doorgegaan omdat hij
-- geannuleerd is, niet omdat er niemand kwam), geen afmelding voor een event,
-- en geen 'wil nog beslissen' — er is helemaal geen gesprek geweest.
--
-- De reden_code eronder (`zelf_geannuleerd` / `geannuleerd_in_agenda`) is een
-- vrije tekstkolom zonder CHECK en hoeft hier niets.
--
-- ── ATOMAIR, EN MET EEN CONTROLE VOORAF ───────────────────────────────────
-- Een CHECK is niet uit te breiden zonder hem te vervangen, en bij het
-- overtikken van de lijst is één vergeten waarde genoeg om elke toekomstige
-- insert met die reden te laten falen. Dat is precies het soort fout dat pas
-- weken later opvalt.
--
-- Daarom één DO-block dat:
--   1. de huidige toegestane waarden uit pg_constraint leest;
--   2. controleert dat de nieuwe lijst er geen enkele van kwijtraakt;
--   3. pas dan de constraint vervangt.
--
-- Valt er iets weg, dan stopt het block met een RAISE EXCEPTION en verandert
-- er niets — de hele DO draait in één transactie. Eén block, geen state die
-- tussen statements door moet overleven, dus de Supabase-editor die op
-- statement-grenzen knipt kan hier niets stukmaken.
--
-- Idempotent: twee keer draaien levert de tweede keer dezelfde constraint op.
-- ============================================================================

DO $$
DECLARE
  huidig      text;
  bestaande   text[];
  gewenst     text[] := ARRAY[
    'wil_nog_beslissen',
    'no_show_event',
    'no_show_call',
    'afgemeld',
    'niet_ingepland',
    'aanmelding',        -- 2026-09-05: instroom bij aanmelding voor een event
    'zoom_nabellen',     -- 2026-09-10: instroom om 12:00 bij een zoomcall
    'zoom_geannuleerd'   -- 2026-09-11: geannuleerde call zonder nieuwe afspraak
  ];
  verdwenen   text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO huidig
    FROM pg_constraint
   WHERE conrelid = 'public.opvolging_taken'::regclass
     AND conname  = 'opvolging_taken_reden_chk';

  IF huidig IS NULL THEN
    RAISE NOTICE 'Geen bestaande opvolging_taken_reden_chk gevonden — de nieuwe wordt gezet.';
  ELSE
    -- Alle waarden tussen enkele quotes uit de constraint-definitie halen.
    SELECT array_agg(g[1]) INTO bestaande
      FROM regexp_matches(huidig, '''([^'']+)''', 'g') AS g;

    SELECT array_agg(b) INTO verdwenen
      FROM unnest(coalesce(bestaande, ARRAY[]::text[])) AS b
     WHERE b <> ALL (gewenst);

    IF verdwenen IS NOT NULL AND array_length(verdwenen, 1) > 0 THEN
      RAISE EXCEPTION
        'STOP: deze migratie zou bestaande reden-waarden weggooien: %. Huidige constraint: %',
        array_to_string(verdwenen, ', '), huidig;
    END IF;

    RAISE NOTICE 'Huidige waarden (%) blijven allemaal behouden.',
      array_to_string(coalesce(bestaande, ARRAY[]::text[]), ', ');
  END IF;

  EXECUTE 'ALTER TABLE public.opvolging_taken '
       || 'DROP CONSTRAINT IF EXISTS opvolging_taken_reden_chk';

  -- DYNAMISCHE SQL, want DDL neemt geen PL/pgSQL-variabele aan: een kale
  -- `CHECK (reden = ANY (gewenst))` zou 'gewenst' als KOLOMNAAM lezen en
  -- falen. format() met %L quote elke waarde netjes.
  EXECUTE format(
    'ALTER TABLE public.opvolging_taken '
    || 'ADD CONSTRAINT opvolging_taken_reden_chk CHECK (reden = ANY (%L::text[]))',
    gewenst);

  RAISE NOTICE 'opvolging_taken_reden_chk staat nu op: %', array_to_string(gewenst, ', ');
END $$;

-- ── Nakijken ────────────────────────────────────────────────────────────────
-- SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--  WHERE conrelid = 'public.opvolging_taken'::regclass
--    AND conname = 'opvolging_taken_reden_chk';
