-- ============================================================================
-- iris_gesprekken.laatste_outbound bijvullen — eenmalig, in batches
-- Datum: 12 oktober 2026
-- Hoort bij: H3 ("Wacht op ons" toonde 569 gesprekken, waarvan 344 afgehandeld)
--
-- ── WAT DIT DOET ────────────────────────────────────────────────────────────
-- Precies één ding: `laatste_outbound` vullen op gesprekken waar hij NULL is,
-- met het tijdstip van het laatste uitgaande bericht in dat gesprek.
--
-- Eén kolom. Eén tabel. Alleen waar de waarde nog leeg is. Geen DELETE, geen
-- DROP, geen ALTER op een bestaande kolom, geen policy die iets intrekt.
--
-- ── GEEN GENERATED COLUMN ───────────────────────────────────────────────────
-- Een eerdere versie van dit plan voegde een gegenereerde kolom `bal_bij_ons`
-- toe. Dat is afgevoerd: ADD COLUMN ... GENERATED ALWAYS AS ... STORED
-- herschrijft de hele tabel onder een ACCESS EXCLUSIVE lock, en dat hoort niet
-- op iris_gesprekken tijdens werkuren. De regel wordt nu in de code toegepast
-- (api/_lib/iris/werkbak.js), op een kandidatenlijst van id plus twee
-- tijdstempels. Alleen deze ene gewone kolom gaat de databank in.
--
-- ── WAAROM HET NODIG IS ─────────────────────────────────────────────────────
-- De kolom bestond al, maar werd alleen gezet door iris-verstuur.js — het
-- verzendpad van Iris zelf, dat nauwelijks gedraaid heeft. Al het échte
-- uitgaande verkeer (automaties, aanmaningen, Joost, mail) kwam via
-- cron-iris-werk binnen, en die raakte de kolom nooit aan.
--
-- Gemeten op 12 oktober in forex-command-center: 569 gesprekken met status
-- nieuw of wacht_op_ons, en `laatste_outbound` gevuld in NUL daarvan. Op basis
-- van het laatste bericht in `iris_berichten`: 225 eindigen inkomend (de bal
-- ligt echt bij ons), 344 eindigen met een bericht van ons.
--
-- De code zet de stempel vanaf nu bij elk uitgaand bericht; dit bestand haalt
-- de geschiedenis in.
--
-- ── IN BATCHES ──────────────────────────────────────────────────────────────
-- Stap 3 doet ÉÉN batch en vertelt hoeveel rijen hij raakte. Draai hem opnieuw
-- tot hij 0 meldt. Elke run is een eigen transactie, dus de rijlocks worden
-- tussen de batches vrijgegeven — daarom losse runs en geen DO-lus, die zou
-- alle locks tot het eind vasthouden en dan is "in batches" alleen een woord.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- `WHERE g.laatste_outbound IS NULL`. Nog eens draaien raakt nul rijen.
--
-- ── SUPABASE SQL-EDITOR ─────────────────────────────────────────────────────
-- Die knipt de invoer op statement-grenzen en draait elk statement in een
-- eigen transactie. Daarom losse statements en geen BEGIN/COMMIT. Draai ze in
-- volgorde, en stap 3 zo vaak als nodig.
-- ============================================================================


-- ── 1. CONTROLE VOORAF ──────────────────────────────────────────────────────
-- Verwacht (12 okt): outbound_gevuld = 0.
SELECT
  count(*)                                         AS gesprekken_totaal,
  count(laatste_outbound)                          AS outbound_gevuld,
  count(*) FILTER (WHERE laatste_outbound IS NULL) AS outbound_leeg
FROM public.iris_gesprekken;

-- Hoeveel gaat dit in totaal raken? De batches uit stap 3 horen bij elkaar
-- opgeteld op dit getal uit te komen.
SELECT count(*) AS gaat_gevuld_worden
FROM public.iris_gesprekken g
WHERE g.laatste_outbound IS NULL
  AND EXISTS (
    SELECT 1 FROM public.iris_berichten b
    WHERE b.gesprek_id = g.id AND b.richting = 'out'
  );

-- En de werkbak nu. Verwacht (12 okt): 569.
SELECT count(*) AS werkbak_nu
FROM public.iris_gesprekken
WHERE status IN ('nieuw', 'wacht_op_ons');


-- ── 2. HET SPOOR VOOR DE TERUGWEG ───────────────────────────────────────────
-- Welke gesprekken déze backfill heeft aangeraakt. Nodig voor stap 5: zonder
-- dit spoor is "alles terugzetten" niet te onderscheiden van "ook terugzetten
-- wat de code sindsdien zelf heeft geschreven".
CREATE TABLE IF NOT EXISTS public.iris_outbound_backfill_20261012 (
  gesprek_id uuid PRIMARY KEY,
  gezet_op   timestamptz NOT NULL,
  op         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.iris_outbound_backfill_20261012 IS
  'Spoor van de eenmalige laatste_outbound-backfill van 12 okt 2026. Alleen voor de terugweg; weggooien mag zodra de uitkomst goedgekeurd is.';

-- RLS aan, en met opzet GEEN policy. Postgres zet RLS standaard UIT, en in
-- Supabase betekent dat: leesbaar via PostgREST met de anon-sleutel. Dit is
-- boekhouding van een migratie; niemand hoeft erbij behalve de service-rol, en
-- die gaat langs RLS heen. Aan zonder policy is hier dus precies goed, en niet
-- een vergeten policy.
ALTER TABLE public.iris_outbound_backfill_20261012 ENABLE ROW LEVEL SECURITY;


-- ── 3. ÉÉN BATCH — DRAAI DIT OPNIEUW TOT ER 0 UITKOMT ───────────────────────
-- Pas desnoods de LIMIT aan; 500 is rustig voor een tabel van deze grootte.
WITH kandidaten AS (
  SELECT g.id
  FROM public.iris_gesprekken g
  WHERE g.laatste_outbound IS NULL
    AND EXISTS (
      SELECT 1 FROM public.iris_berichten b
      WHERE b.gesprek_id = g.id AND b.richting = 'out'
    )
  ORDER BY g.id
  LIMIT 500
),
laatste AS (
  SELECT b.gesprek_id, max(b.ontvangen_op) AS op
  FROM public.iris_berichten b
  JOIN kandidaten k ON k.id = b.gesprek_id
  WHERE b.richting = 'out'
  GROUP BY b.gesprek_id
),
gezet AS (
  UPDATE public.iris_gesprekken g
  SET laatste_outbound = l.op
  FROM laatste l
  WHERE g.id = l.gesprek_id
    AND g.laatste_outbound IS NULL
  RETURNING g.id, l.op
),
spoor AS (
  INSERT INTO public.iris_outbound_backfill_20261012 (gesprek_id, gezet_op)
  SELECT id, op FROM gezet
  ON CONFLICT (gesprek_id) DO NOTHING
  RETURNING 1
)
SELECT
  (SELECT count(*) FROM gezet)  AS deze_batch,
  (SELECT count(*) FROM spoor)  AS in_spoor_gezet;


-- ── 4. CONTROLE ACHTERAF ────────────────────────────────────────────────────
-- Alles gevuld wat een uitgaand bericht heeft? Verwacht: 0.
SELECT count(*) AS nog_te_doen
FROM public.iris_gesprekken g
WHERE g.laatste_outbound IS NULL
  AND EXISTS (
    SELECT 1 FROM public.iris_berichten b
    WHERE b.gesprek_id = g.id AND b.richting = 'out'
  );

-- Wat de nieuwe werkbak-regel overhoudt: er kwam iets binnen NÁ ons laatste
-- bericht. Verwacht rond de 225.
SELECT count(*) AS bal_bij_ons
FROM public.iris_gesprekken
WHERE status = 'wacht_op_ons'
  AND laatste_inbound IS NOT NULL
  AND (laatste_outbound IS NULL OR laatste_inbound > laatste_outbound);

-- En wat er uit de werkbak verdwijnt: ons bericht was het laatste. Die
-- gesprekken zijn NIET weg — ze staan onder "Wacht op klant".
SELECT count(*) AS bal_bij_de_klant
FROM public.iris_gesprekken
WHERE status = 'wacht_op_ons'
  AND laatste_outbound IS NOT NULL
  AND (laatste_inbound IS NULL OR laatste_inbound <= laatste_outbound);

-- Hoeveel er naar "nog in te delen" verhuist (status 'nieuw').
SELECT count(*) AS nog_in_te_delen
FROM public.iris_gesprekken
WHERE status = 'nieuw';

-- Niets anders aangeraakt. Hoort gelijk te zijn aan wat je ervoor zag.
SELECT count(*) AS whatsapp_conversations_onaangeroerd FROM public.whatsapp_conversations;


-- ── 5. DE TERUGWEG ──────────────────────────────────────────────────────────
-- ⚠ NIET draaien tenzij de uitkomst fout is. Hieronder staat het NIET
-- uitgecommentarieerd om een reden: een rollback die je moet samenstellen
-- terwijl er iets misgaat, is geen rollback. Kopieer de regel die je nodig
-- hebt.
--
-- Dit zet laatste_outbound terug op NULL voor precies de gesprekken die déze
-- backfill heeft aangeraakt. Let op twee dingen:
--
--   1. Als de code sindsdien zelf een nieuwere stempel heeft gezet op zo'n
--      gesprek, wordt die hierdoor OOK gewist. De `AND laatste_outbound =
--      gezet_op` hieronder voorkomt dat: alleen terugzetten wat nog exact de
--      waarde heeft die de backfill schreef.
--   2. De werkbak valt daarmee terug op de oude (te lange) lijst. Dat is geen
--      storing — de code werkt zonder gevulde kolom, hij toont dan alleen meer.
--
-- UPDATE public.iris_gesprekken g
-- SET laatste_outbound = NULL
-- FROM public.iris_outbound_backfill_20261012 s
-- WHERE g.id = s.gesprek_id
--   AND g.laatste_outbound = s.gezet_op;
--
-- En daarna, als je ook het spoor kwijt wil:
-- DROP TABLE public.iris_outbound_backfill_20261012;
