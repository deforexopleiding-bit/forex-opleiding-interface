-- ============================================================================
-- iris_gesprekken.laatste_outbound bijvullen — eenmalig, in batches
-- Datum: 13 oktober 2026
-- Vervangt: archived/2026-10-12-iris-laatste-outbound-backfill.sql (⛔ die niet)
-- Hoort bij: H3 ("Wacht op ons" toonde 569 gesprekken, waarvan 344 afgehandeld)
--
-- ── WAAROM ER EEN TWEEDE VERSIE IS ──────────────────────────────────────────
-- De eerste filterde op `iris_berichten.richting = 'out'`. Die waarde bestaat
-- niet. De CHECK op die kolom is `IN ('in','uit')`, en gemeten in productie op
-- 13 oktober: 906 rijen 'in' en 1610 rijen 'uit'. De oude backfill zou dus
-- NUL rijen hebben gevuld.
--
-- Dezelfde fout zat in de code: cron-iris-werk vergeleek `vorm.richting` met
-- 'out', terwijl waRichting() 'uit' teruggeeft. `laatste_outbound` werd
-- daardoor nooit gestempeld -- en omdat balBijOns() bij een lege kolom `true`
-- teruggeeft ("niets van ons bekend, dus het wacht op ons"), stond de hele
-- regel van H3 stil in productie zonder één foutmelding. Die code is nu gefixt
-- met één constante (RICHTING in api/_lib/iris/opname.js); dit bestand haalt de
-- geschiedenis in.
--
-- De oude SPOORTABEL (iris_outbound_backfill_20261012) is NIET aangemaakt als
-- je die migratie niet gedraaid hebt. Staat hij er wel, dan is hij leeg en mag
-- hij weg; dit bestand gebruikt zijn eigen spoor met de datum van vandaag.
--
-- ── WAT DIT DOET ────────────────────────────────────────────────────────────
-- Precies één ding: `laatste_outbound` vullen op gesprekken waar hij NULL is,
-- met het tijdstip van het laatste UITGAANDE bericht in dat gesprek.
--
-- Eén kolom. Eén tabel. Alleen waar de waarde nog leeg is. Geen DELETE, geen
-- DROP, geen ALTER op een bestaande kolom, geen policy die iets intrekt.
--
-- ── IN BATCHES ──────────────────────────────────────────────────────────────
-- Stap 3 doet ÉÉN batch en vertelt hoeveel rijen hij raakte. Draai hem opnieuw
-- tot hij 0 meldt. Elke run is een eigen transactie, dus de rijlocks worden
-- tussen de batches vrijgegeven -- daarom losse runs en geen DO-lus, die zou
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


-- ── 0. DE AANNAME CONTROLEREN, VÓÓR ALLES ───────────────────────────────────
-- Dit is de stap die de vorige versie niet had, en die had hem gered.
-- Verwacht: twee rijen, 'in' en 'uit'. Staat er een derde waarde, of heet er
-- iets anders, dan STOP en zeg het -- dan klopt de rest van dit bestand niet.
SELECT richting, count(*) AS aantal
FROM public.iris_berichten
GROUP BY richting
ORDER BY aantal DESC;


-- ── 1. CONTROLE VOORAF ──────────────────────────────────────────────────────
-- Verwacht: outbound_gevuld = 0 (de code heeft hem nooit gezet).
SELECT
  count(*)                                         AS gesprekken_totaal,
  count(laatste_outbound)                          AS outbound_gevuld,
  count(*) FILTER (WHERE laatste_outbound IS NULL) AS outbound_leeg
FROM public.iris_gesprekken;

-- Hoeveel gaat dit in totaal raken? De batches uit stap 3 horen bij elkaar
-- opgeteld op dit getal uit te komen. Verwacht: een paar honderd, niet 0.
-- Komt hier 0 uit, draai dan stap 0 nog eens -- dan is de waarde niet 'uit'.
SELECT count(*) AS gaat_gevuld_worden
FROM public.iris_gesprekken g
WHERE g.laatste_outbound IS NULL
  AND EXISTS (
    SELECT 1 FROM public.iris_berichten b
    WHERE b.gesprek_id = g.id AND b.richting = 'uit'
  );

-- En de werkbak nu. Verwacht (12 okt gemeten): 569.
SELECT count(*) AS werkbak_nu
FROM public.iris_gesprekken
WHERE status IN ('nieuw', 'wacht_op_ons');


-- ── 2. HET SPOOR VOOR DE TERUGWEG ───────────────────────────────────────────
-- Welke gesprekken déze backfill heeft aangeraakt. Nodig voor stap 5: zonder
-- dit spoor is "alles terugzetten" niet te onderscheiden van "ook terugzetten
-- wat de code sindsdien zelf heeft geschreven".
CREATE TABLE IF NOT EXISTS public.iris_outbound_backfill_20261013 (
  gesprek_id uuid PRIMARY KEY,
  gezet_op   timestamptz NOT NULL,
  op         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.iris_outbound_backfill_20261013 IS
  'Spoor van de eenmalige laatste_outbound-backfill van 13 okt 2026. Alleen voor de terugweg; weggooien mag zodra de uitkomst goedgekeurd is.';

-- RLS aan, en met opzet GEEN policy. Postgres zet RLS standaard UIT, en in
-- Supabase betekent dat: leesbaar via PostgREST met de anon-sleutel. Dit is
-- boekhouding van een migratie; niemand hoeft erbij behalve de service-rol, en
-- die gaat langs RLS heen. Aan zonder policy is hier dus precies goed, en niet
-- een vergeten policy.
ALTER TABLE public.iris_outbound_backfill_20261013 ENABLE ROW LEVEL SECURITY;


-- ── 3. ÉÉN BATCH — DRAAI DIT OPNIEUW TOT ER 0 UITKOMT ───────────────────────
-- Pas desnoods de LIMIT aan; 500 is rustig voor een tabel van deze grootte.
WITH kandidaten AS (
  SELECT g.id
  FROM public.iris_gesprekken g
  WHERE g.laatste_outbound IS NULL
    AND EXISTS (
      SELECT 1 FROM public.iris_berichten b
      WHERE b.gesprek_id = g.id AND b.richting = 'uit'
    )
  ORDER BY g.id
  LIMIT 500
),
laatste AS (
  SELECT b.gesprek_id, max(b.ontvangen_op) AS op
  FROM public.iris_berichten b
  JOIN kandidaten k ON k.id = b.gesprek_id
  WHERE b.richting = 'uit'
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
  INSERT INTO public.iris_outbound_backfill_20261013 (gesprek_id, gezet_op)
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
    WHERE b.gesprek_id = g.id AND b.richting = 'uit'
  );

-- Wat de nieuwe werkbak-regel overhoudt: er kwam iets binnen NÁ ons laatste
-- bericht. Verwacht rond de 225.
SELECT count(*) AS bal_bij_ons
FROM public.iris_gesprekken
WHERE status = 'wacht_op_ons'
  AND laatste_inbound IS NOT NULL
  AND (laatste_outbound IS NULL OR laatste_inbound > laatste_outbound);

-- En wat er uit de werkbak verdwijnt: ons bericht was het laatste. Die
-- gesprekken zijn NIET weg -- ze staan onder "Wacht op klant". Verwacht rond
-- de 344; dat is het getal dat je terugziet als "minder in de werkbak".
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
--      storing -- de code werkt zonder gevulde kolom, hij toont dan alleen meer.
--
-- UPDATE public.iris_gesprekken g
-- SET laatste_outbound = NULL
-- FROM public.iris_outbound_backfill_20261013 s
-- WHERE g.id = s.gesprek_id
--   AND g.laatste_outbound = s.gezet_op;
--
-- En daarna, als je ook het spoor kwijt wil:
-- DROP TABLE public.iris_outbound_backfill_20261013;
--
-- Staat de LEGE spoortabel van de afgevoerde versie er nog, dan mag die ook:
-- DROP TABLE IF EXISTS public.iris_outbound_backfill_20261012;
