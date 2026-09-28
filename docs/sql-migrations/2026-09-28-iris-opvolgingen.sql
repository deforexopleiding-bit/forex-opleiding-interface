-- 2026-09-28 — Iris: opvolgingen die echt opvolgen (O-2)
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠ DEZE MIGRATIE IS BLOKKEREND VOOR ÉÉN NIEUW STAPTYPE
-- ═══════════════════════════════════════════════════════════════════════════
-- De code noemt `opvolging_instellen` bij naam, en `iris_acties.type` heeft een
-- CHECK. Zolang deze migratie niet gedraaid is:
--
--   · Alles wat er nu is blijft werken. Post, Opdrachten, Belrij, de bestaande
--     negen staptypes: niets verandert daaraan.
--   · Maar zet Iris `opvolging_instellen` in een plan en druk je op Uitvoeren,
--     dan faalt het klaarzetten met een CHECK-schending (23514) en zie je
--     "nieuwe rij schendt de check-constraint". Niet stil: zichtbaar.
--   · En `iris_opvolgingen` bestaat niet, dus de cron cron-iris-opvolging logt
--     bij elke ronde dat de tabel er niet is en doet verder niets.
--
-- Draaien dus VÓÓR of DIRECT NA de merge van de bijbehorende PR.
--
-- ── WAAROM EEN EIGEN TABEL EN NIET pending_actions ─────────────────────────
-- pending_actions is het WERKBAKJE van de wanbetalersmodule, en de zijbalk telt
-- de rijen met status PENDING. Een opvolging is geen taak maar een WACHT: er
-- hoeft niemand iets te doen tot de termijn om is. Hem daar neerzetten zou het
-- badge-getal opblazen met iets waar niemand op kan handelen -- precies de fout
-- die P-2 uit de Post haalde, een module verderop.
--
-- ── DRAAIEN IN DE SUPABASE SQL-EDITOR ──────────────────────────────────────
-- Die knipt de invoer op statement-grenzen en draait elk statement in een eigen
-- transactie (zie CLAUDE.md). Daarom: losse statements, geen TEMP-tabellen,
-- geen DO-blok dat state van een ander DO-blok verwacht. De controle vooraf en
-- achteraf zijn gewone SELECTs die je zelf vergelijkt.


-- ───────────────────────────────────────────────────────────────────────────
-- CONTROLE VOORAF — draai dit eerst en bewaar de uitkomst
-- ───────────────────────────────────────────────────────────────────────────
-- Verwacht vóór de migratie:
--   tabel_bestaat = false
--   check_kent_opvolging = false
--   acties_totaal = <wat er nu staat; dit getal mag NIET veranderen>

SELECT
  EXISTS (SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'iris_opvolgingen')  AS tabel_bestaat,
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.iris_acties'::regclass
            AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%opvolging_instellen%')       AS check_kent_opvolging,
  (SELECT count(*) FROM public.iris_acties)                                   AS acties_totaal;


-- ───────────────────────────────────────────────────────────────────────────
-- 1. iris_acties.type — het nieuwe staptype toelaten
-- ───────────────────────────────────────────────────────────────────────────
-- De CHECK wordt VERVANGEN, niet verruimd tot "alles mag". Wat er niet in staat
-- kan Iris niet, ook niet per ongeluk -- blokkeren en toegang intrekken blijven
-- dus ontbreken, en dat is de hele reden dat deze lijst een lijst is.
--
-- De naam van de constraint staat niet vast (Postgres verzint hem), dus hem
-- opzoeken in plaats van gokken. Eén DO-blok, zelfstandig, geen state van
-- buiten nodig.

DO $$
DECLARE
  naam text;
BEGIN
  SELECT conname INTO naam
    FROM pg_constraint
   WHERE conrelid = 'public.iris_acties'::regclass
     AND contype  = 'c'
     AND pg_get_constraintdef(oid) LIKE '%wa_versturen%';

  IF naam IS NULL THEN
    RAISE NOTICE 'Geen type-CHECK gevonden op iris_acties — niets vervangen.';
  ELSE
    EXECUTE format('ALTER TABLE public.iris_acties DROP CONSTRAINT %I', naam);
    RAISE NOTICE 'CHECK % verwijderd.', naam;
  END IF;

  ALTER TABLE public.iris_acties
    ADD CONSTRAINT iris_acties_type_check CHECK (type IN (
      'wa_versturen','mail_versturen',
      'lms_toegang_verlengen','lms_uitnodiging','lms_on_hold',
      'belofte_vastleggen','afbetalingsplan',
      'taak_aanmaken','belrij_toevoegen','factuur_nakijken',
      'opvolging_instellen'));
END $$;


-- ───────────────────────────────────────────────────────────────────────────
-- 2. iris_opvolgingen — "verwittig me als er geen reactie komt"
-- ───────────────────────────────────────────────────────────────────────────
-- Drie dingen liggen hier vast, en dat zijn precies de drie waar om gevraagd
-- werd en waarvan er nul gebeurden:
--
--   WAAROP  wordt gewacht  → gesprek_id (of contact_id)
--   TOT     wanneer        → `tot`
--   WIE     krijgt bericht → verwittig_email, bij het maken vastgelegd
--
-- `sinds` is het ijkpunt: een bericht telt alleen als reactie als het NA dit
-- moment binnenkwam. Zonder dat veld zou een bericht van vorige week de
-- opvolging meteen sluiten.

CREATE TABLE IF NOT EXISTS public.iris_opvolgingen (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opdracht_id       uuid REFERENCES public.iris_opdrachten(id) ON DELETE SET NULL,
  actie_id          uuid REFERENCES public.iris_acties(id)     ON DELETE SET NULL,
  gesprek_id        uuid REFERENCES public.iris_gesprekken(id) ON DELETE CASCADE,
  contact_id        uuid REFERENCES public.iris_contacten(id)  ON DELETE CASCADE,
  waarop            text NOT NULL CHECK (waarop IN ('gesprek','contact')),
  omschrijving      text NOT NULL,
  sinds             timestamptz NOT NULL DEFAULT now(),
  tot               timestamptz NOT NULL,
  verwittig_email   text,
  verwittig_wie     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'kijkt'
                      CHECK (status IN ('kijkt','reactie','verlopen','gemeld','afgebroken')),
  gezien_bericht_id uuid REFERENCES public.iris_berichten(id) ON DELETE SET NULL,
  gezien_op         timestamptz,
  meld_pogingen     integer NOT NULL DEFAULT 0,
  gemeld_op         timestamptz,
  meld_fout         text,
  aangemaakt_door   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  aangemaakt_op     timestamptz NOT NULL DEFAULT now(),
  bijgewerkt_op     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.iris_opvolgingen IS
  'Iris: "verwittig me als er geen reactie komt". Geen taak maar een wacht — daarom niet in pending_actions, waar de zijbalk op telt.';
COMMENT ON COLUMN public.iris_opvolgingen.sinds IS
  'Het ijkpunt. Een bericht telt alleen als reactie als het NA dit moment binnenkwam; anders sluit een bericht van vorige week de opvolging meteen.';
COMMENT ON COLUMN public.iris_opvolgingen.status IS
  'kijkt -> reactie (er kwam iets) | verlopen (termijn om, nog niet gemeld) -> gemeld | afgebroken (een mens stopte het).';
COMMENT ON COLUMN public.iris_opvolgingen.meld_pogingen IS
  'Gecapt in de cron. Een melding die blijft falen mag niet elke ronde opnieuw mailen — zie de les over 95 alarmmails per dag in CLAUDE.md.';
COMMENT ON COLUMN public.iris_opvolgingen.verwittig_email IS
  'Bij het MAKEN vastgelegd, niet bij het melden opgezocht. Wie de opvolging vroeg, krijgt het bericht — ook als zijn rol intussen veranderd is.';

-- De cron vraagt precies één ding: welke opvolgingen kijken nog en zijn om?
CREATE INDEX IF NOT EXISTS idx_iris_opvolgingen_open
  ON public.iris_opvolgingen (tot) WHERE status = 'kijkt';
-- En bij het melden: welke staan er te wachten op een tweede poging?
CREATE INDEX IF NOT EXISTS idx_iris_opvolgingen_verlopen
  ON public.iris_opvolgingen (bijgewerkt_op) WHERE status = 'verlopen';
CREATE INDEX IF NOT EXISTS idx_iris_opvolgingen_gesprek
  ON public.iris_opvolgingen (gesprek_id, aangemaakt_op DESC);
CREATE INDEX IF NOT EXISTS idx_iris_opvolgingen_opdracht
  ON public.iris_opvolgingen (opdracht_id);


-- ───────────────────────────────────────────────────────────────────────────
-- 3. RLS — dicht, met dezelfde rolcheck als de rest van Iris
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE public.iris_opvolgingen ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS iris_opvolgingen_staff ON public.iris_opvolgingen;
CREATE POLICY iris_opvolgingen_staff ON public.iris_opvolgingen
  FOR ALL TO authenticated
  USING (public.is_crm_staff()) WITH CHECK (public.is_crm_staff());


-- ───────────────────────────────────────────────────────────────────────────
-- CONTROLE ACHTERAF — vergelijk met de uitkomst van vooraf
-- ───────────────────────────────────────────────────────────────────────────
-- Verwacht ná de migratie:
--   tabel_bestaat = true
--   check_kent_opvolging = true
--   acties_totaal = HETZELFDE getal als vooraf   ← er is geen rij aangeraakt
--   opvolgingen_totaal = 0                        ← een lege nieuwe tabel
--   rls_aan = true
--   indexen = 4

SELECT
  EXISTS (SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'iris_opvolgingen')  AS tabel_bestaat,
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.iris_acties'::regclass
            AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%opvolging_instellen%')       AS check_kent_opvolging,
  (SELECT count(*) FROM public.iris_acties)                                   AS acties_totaal,
  (SELECT count(*) FROM public.iris_opvolgingen)                              AS opvolgingen_totaal,
  (SELECT relrowsecurity FROM pg_class
    WHERE oid = 'public.iris_opvolgingen'::regclass)                          AS rls_aan,
  (SELECT count(*) FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'iris_opvolgingen'
      AND indexname LIKE 'idx_iris_opvolgingen%')                             AS indexen;

-- Gaat er iets mis, dan is de weg terug:
--   DROP TABLE IF EXISTS public.iris_opvolgingen;
-- en de CHECK terugzetten zonder 'opvolging_instellen'. Er is geen bestaande
-- rij aangeraakt, dus er valt niets te herstellen.
