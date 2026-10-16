-- ============================================================================
-- HERKOMST-VRAAG in de vragenlijsten — "Hoe heb je ons gevonden?"
-- ============================================================================
-- ✅ REEDS LIVE GEDRAAID op 2026-08-04 (handmatig in Supabase). Administratie/
--    naslag, geen to-do. Idempotent → veilig te herhalen.
--
-- ⚠ SUPABASE-EDITOR: draai NIET als één bestand. De editor knipt hele files
--    verkeerd op (splitst binnen het DO $$-blok). Plak en draai elk blok los:
--    de STAP-0-dumps, dan het DO $$…END $$-blok, dan de verify-queries.
--
-- Context (Feature 2): de #28-route (dfo lib/quiz.ts → beoordeel) herkent de
-- herkomst-vraag aan het LABEL via /hoe heb je ons gevonden/i — er is GEEN
-- id-marker. De optie-labels worden geslugd (label.toLowerCase().replace(/\s+/g,'-'))
-- naar leads.soort = herkomst. Alle punten 0 + geen afwijzer → scoring/drempel
-- ongewijzigd. Alleen de quizzes die naar /api/lead posten krijgen de vraag:
-- '7-daagse' en 'student' (de route valideert exact deze twee).
--
-- Tabellen:
--   * werk-tabel  public.website_quizzes           (quiz per slug)
--   * werk-tabel  public.website_quiz_questions     (id, quiz_id, order_index, label, options, active)
--   * gepubliceerd public.website_quiz_publicaties  (slug, versie, inhoud jsonb, is_actueel)
--     'inhoud' = jsonb_agg({id, order_index, label, options}) uit de werk-tabel.
-- ============================================================================


-- ── STAP 0 — DUMPS ter reconciliatie (los draaien, informatief) ─────────────
-- 0a) Welke quizzes bestaan er (bevestig 7-daagse + student)?
SELECT id, slug, naam, drempel, is_active FROM public.website_quizzes ORDER BY slug;

-- 0b) Actuele snapshots + aantal vragen.
SELECT slug, versie, is_actueel, jsonb_array_length(inhoud) AS n_vragen
FROM public.website_quiz_publicaties WHERE is_actueel ORDER BY slug;

-- 0c) JSON-schema + invoegplek: bekijk de inhoud-structuur van één snapshot.
SELECT jsonb_pretty(inhoud) FROM public.website_quiz_publicaties
WHERE slug = '7-daagse' AND is_actueel;

-- 0d) Exacte kolommen van de werk-tabel (reconcilieer de INSERT hieronder;
--     vul aan als er NOT NULL-kolommen zonder default zijn).
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema='public' AND table_name='website_quiz_questions'
ORDER BY ordinal_position;


-- ── STAP 1-2 — toevoegen (ÉÉN DO-blok, draait als geheel; idempotent) ───────
-- Voegt "Hoe heb je ons gevonden?" toe aan de WERK-tabel én de actuele SNAPSHOT
-- voor elke quiz die naar /api/lead post. Idempotent op label (geen dubbele vraag).
-- Het vraag-id wordt per quiz gegenereerd en op beide plekken hetzelfde gebruikt,
-- zodat een latere "Publiceren" dezelfde vraag/id reproduceert.
DO $$
DECLARE
  r     record;
  v_qid uuid;
  v_opts jsonb := '[
    {"label":"Instagram","punten":0,"afwijzer":false},
    {"label":"Facebook","punten":0,"afwijzer":false},
    {"label":"Google","punten":0,"afwijzer":false},
    {"label":"Via-via","punten":0,"afwijzer":false},
    {"label":"LinkedIn","punten":0,"afwijzer":false},
    {"label":"TikTok","punten":0,"afwijzer":false},
    {"label":"Overige","punten":0,"afwijzer":false}
  ]'::jsonb;
BEGIN
  FOR r IN
    SELECT id, slug FROM public.website_quizzes WHERE slug IN ('7-daagse','student')
  LOOP
    -- 1) WERK-tabel: vraag toevoegen (idempotent op quiz_id + label). Achteraan.
    IF NOT EXISTS (
      SELECT 1 FROM public.website_quiz_questions
      WHERE quiz_id = r.id AND label = 'Hoe heb je ons gevonden?'
    ) THEN
      INSERT INTO public.website_quiz_questions (quiz_id, order_index, label, options, active)
      VALUES (
        r.id,
        COALESCE((SELECT max(order_index) FROM public.website_quiz_questions WHERE quiz_id = r.id), 0) + 1,
        'Hoe heb je ons gevonden?',
        v_opts,
        true
      )
      RETURNING id INTO v_qid;
    ELSE
      SELECT id INTO v_qid FROM public.website_quiz_questions
      WHERE quiz_id = r.id AND label = 'Hoe heb je ons gevonden?' LIMIT 1;
    END IF;

    -- 2) ACTUELE snapshot: append met DEZELFDE id (idempotent op label).
    --    Zet 'm achteraan (order_index 999).
    UPDATE public.website_quiz_publicaties p
    SET inhoud = p.inhoud || jsonb_build_array(jsonb_build_object(
          'id',          v_qid::text,
          'order_index', 999,
          'label',       'Hoe heb je ons gevonden?',
          'options',     v_opts
        ))
    WHERE p.slug = r.slug
      AND p.is_actueel
      AND NOT (p.inhoud @> jsonb_build_array(jsonb_build_object('label','Hoe heb je ons gevonden?')));
  END LOOP;
END $$;


-- ── STAP-verify — aantonen dat de vraag overal staat (los draaien) ──────────
-- 3a) In de WERK-tabel: één herkomst-vraag per quiz, met id + opties.
SELECT q.slug, qq.id, qq.order_index, qq.label, jsonb_array_length(qq.options) AS n_opties
FROM public.website_quiz_questions qq
JOIN public.website_quizzes q ON q.id = qq.quiz_id
WHERE qq.label = 'Hoe heb je ons gevonden?'
ORDER BY q.slug;

-- 3b) In de ACTUELE snapshots: de vraag zit in inhoud, met bijbehorend id.
SELECT p.slug,
       (elem->>'id')    AS vraag_id,
       (elem->>'label') AS label,
       jsonb_array_length(elem->'options') AS n_opties
FROM public.website_quiz_publicaties p,
     LATERAL jsonb_array_elements(p.inhoud) elem
WHERE p.is_actueel AND elem->>'label' = 'Hoe heb je ons gevonden?'
ORDER BY p.slug;

-- 3c) Sanity: de vraag telt niet mee in de scoring (alle punten 0, geen afwijzer).
SELECT p.slug,
       bool_and((opt->>'punten')::int = 0)        AS alle_punten_nul,
       bool_and((opt->>'afwijzer')::bool = false) AS geen_afwijzer
FROM public.website_quiz_publicaties p,
     LATERAL jsonb_array_elements(p.inhoud) elem,
     LATERAL jsonb_array_elements(elem->'options') opt
WHERE p.is_actueel AND elem->>'label' = 'Hoe heb je ons gevonden?'
GROUP BY p.slug;
