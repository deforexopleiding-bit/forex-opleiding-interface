-- ══════════════════════════════════════════════════════════════════════════
-- No-show-signalen overdragen aan het LMS — 17 september 2026
-- ══════════════════════════════════════════════════════════════════════════
--
-- NIET DOOR CLAUDE GEDRAAID. Cowork draait dit na controle, met de hand.
--
-- WAT DIT DOET
--   Sluit de nog openstaande CRM-signalen van de twee AUTOMATISCHE
--   no-show-types af. De opvolging gebeurt voortaan volledig in het LMS
--   (hlms_signaal, hoofdmentorbord). De cron die deze signalen aanmaakte is
--   in dezelfde PR uitgezet, dus er komen er geen bij.
--
-- WAT DIT NIET DOET
--   • Er wordt NIETS verwijderd. Geen DELETE, geen DROP, geen TRUNCATE.
--     De rijen blijven staan; alleen hun status gaat naar 'afgehandeld'.
--   • De andere signaaltypes blijven ONAANGEROERD: 'reageert_niet',
--     'eerste_call', 'niet_bereikbaar', 'geen_reactie_bellen', 'anders'.
--     Die komen van mentoren en gaan over iets anders.
--   • Reeds afgehandelde signalen worden niet opnieuw aangeraakt.
--
-- TERUGDRAAIEN
--   Stap 1 zet ELKE geraakte id, met de status die hij had, in
--   `student_signals_lms_overdracht`. Daarmee is stap 2 exact terug te
--   draaien; de rollback staat onderaan dit bestand.
--
-- IDEMPOTENT
--   Twee keer draaien verandert niets extra: stap 1 heeft een unique index
--   op signal_id, stap 2 raakt alleen rijen die nog niet 'afgehandeld' zijn.
--
-- SUPABASE SQL-EDITOR
--   Losse statements, geen TEMP-tabellen, geen DO-blok dat state van een
--   ander blok verwacht. De editor knipt op statement-grenzen (elk statement
--   een eigen transactie) en dat mag hier geen verschil maken. Draai ze in
--   deze volgorde; stap 0 en 3 zijn alleen om te kijken.
-- ══════════════════════════════════════════════════════════════════════════


-- ── STAP 0 — KIJKEN (verandert niets) ────────────────────────────────────
-- Draai dit eerst. Verwacht op 16 september gemeten: 39 × no_show en
-- 3 × eerste_call_no_show met status 'open'. Wijkt het sterk af, stop dan
-- en overleg — dan is er iets veranderd sinds de meting.

SELECT type, status, count(*) AS aantal
FROM public.student_signals
WHERE type IN ('no_show', 'eerste_call_no_show')
GROUP BY type, status
ORDER BY type, status;


-- ── STAP 1 — DE LIJST VASTLEGGEN (schrijft alleen naar de logtabel) ──────
-- Dit is het terugdraai-spoor. Pas hierna mag stap 2.

CREATE TABLE IF NOT EXISTS public.student_signals_lms_overdracht (
  signal_id         uuid PRIMARY KEY REFERENCES public.student_signals(id),
  type              text        NOT NULL,
  status_voor       text        NOT NULL,
  uitkomst_voor     text,
  uitkomst_type_voor text,
  handled_at_voor   timestamptz,
  bubble_student_id text,
  student_name      text,
  signaal_gemaakt_op timestamptz,
  overgedragen_op   timestamptz NOT NULL DEFAULT now()
);

-- RLS AAN, ZONDER POLICIES → alleen de service-role komt erbij.
--
-- TOEGEVOEGD NA DE EERSTE RUN (17-09-2026). Supabase waarschuwde terecht:
-- zonder deze regel is de tabel via PostgREST leesbaar met de anon-sleutel,
-- en er staan studentnamen in. Cowork heeft de regel meteen bij de hand
-- gedraaid; hij staat hier zodat het bestand gelijk is aan productie.
--
-- Opnieuw draaien is een no-op: ENABLE ROW LEVEL SECURITY op een tabel die
-- het al aan heeft doet niets. Geen policies erbij — niets in het CRM leest
-- deze tabel met een gebruikers-token; hij bestaat alleen om terug te kunnen
-- draaien. Zelfde patroon als migratie 017 voor student_signals zelf.
ALTER TABLE public.student_signals_lms_overdracht ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.student_signals_lms_overdracht IS
  'Terugdraai-spoor van de overdracht van no-show-opvolging naar het LMS '
  '(17-09-2026). Eén rij per signaal dat toen is afgesloten, met de stand '
  'van vóór. Zie docs/sql-migrations/2026-09-17-noshow-signalen-naar-lms.sql.';

INSERT INTO public.student_signals_lms_overdracht (
  signal_id, type, status_voor, uitkomst_voor, uitkomst_type_voor,
  handled_at_voor, bubble_student_id, student_name, signaal_gemaakt_op
)
SELECT s.id, s.type, s.status, s.uitkomst, s.uitkomst_type,
       s.handled_at, s.bubble_student_id, s.student_name, s.created_at
FROM public.student_signals s
WHERE s.type IN ('no_show', 'eerste_call_no_show')
  AND s.status <> 'afgehandeld'
ON CONFLICT (signal_id) DO NOTHING;

-- Kijk wat er vastgelegd is — dit is de lijst die in de PR hoort.
SELECT signal_id, type, status_voor, student_name, signaal_gemaakt_op
FROM public.student_signals_lms_overdracht
ORDER BY type, signaal_gemaakt_op;


-- ── STAP 2 — AFSLUITEN ───────────────────────────────────────────────────
-- Let op: dit sluit zowel 'open' als 'opnieuw_opvolgen'. Allebei zijn het
-- signalen die nog op iemand wachten; alleen 'open' afsluiten zou precies de
-- restlijst laten staan die we juist kwijt willen.
--
-- `uitkomst_type = 'anders'` is de enige waarde die de CHECK-constraint
-- toelaat voor een uitkomst die geen van de bestaande gevallen is; de
-- leesbare reden staat in `uitkomst`.

UPDATE public.student_signals s
SET status        = 'afgehandeld',
    uitkomst      = 'Vervangen door de LMS-opvolging (hoofdmentorbord)',
    uitkomst_type = 'anders',
    handled_at    = now(),
    updated_at    = now()
WHERE s.type IN ('no_show', 'eerste_call_no_show')
  AND s.status <> 'afgehandeld'
  -- Alleen wat in stap 1 is vastgelegd. Zonder deze regel zou een signaal
  -- dat ná stap 1 ontstaat (kan niet meer — de cron staat uit — maar toch)
  -- afgesloten worden zonder terugdraai-spoor.
  AND EXISTS (
    SELECT 1 FROM public.student_signals_lms_overdracht o
    WHERE o.signal_id = s.id
  );


-- ── STAP 3 — CONTROLEREN (verandert niets) ───────────────────────────────
-- Verwacht: alles op 'afgehandeld', en het aantal in de logtabel is gelijk
-- aan het aantal dat in stap 0 nog open stond.

SELECT type, status, count(*) AS aantal
FROM public.student_signals
WHERE type IN ('no_show', 'eerste_call_no_show')
GROUP BY type, status
ORDER BY type, status;

SELECT count(*) AS vastgelegd FROM public.student_signals_lms_overdracht;

-- En de tegenproef: de andere types zijn niet aangeraakt.
SELECT type, status, count(*) AS aantal
FROM public.student_signals
WHERE type NOT IN ('no_show', 'eerste_call_no_show')
GROUP BY type, status
ORDER BY type, status;


-- ══════════════════════════════════════════════════════════════════════════
-- ROLLBACK (alleen bij twijfel draaien — zet de oude stand exact terug)
-- ══════════════════════════════════════════════════════════════════════════
--
-- UPDATE public.student_signals s
-- SET status        = o.status_voor,
--     uitkomst      = o.uitkomst_voor,
--     uitkomst_type = o.uitkomst_type_voor,
--     handled_at    = o.handled_at_voor,
--     updated_at    = now()
-- FROM public.student_signals_lms_overdracht o
-- WHERE o.signal_id = s.id
--   AND s.uitkomst = 'Vervangen door de LMS-opvolging (hoofdmentorbord)';
--
-- De logtabel zelf blijft daarna staan; die is het bewijs dat het gebeurd is.
