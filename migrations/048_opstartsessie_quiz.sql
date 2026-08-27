-- ============================================================================
-- Migratie 048: Opstartsessie-kwalificatie-vragenlijst (6 vragen, drempel 9)
-- Datum: 2026-08-27
-- Doel:  nieuwe slug 'opstartsessie' in website_quizzes + 6 vragen +
--        publicatie versie 1 (is_actueel=true). De publieke pagina op
--        deforexopleiding.nl/opstartsessie leest deze slug in plaats van
--        'student', zodat de 7-daagse/student-flow op de marketing-site
--        onaangeroerd blijft.
--
-- Fase-0-keuze (bevestigd): grep in de CRM-repo toont geen runtime-caller
-- voor de 'student'-slug — die wordt alleen door de externe website
-- gelezen. Om zeker geen andere pagina te raken kiezen we voor een NIEUWE
-- slug ('opstartsessie'); dfo-website switcht in feat/opstartsessie de
-- proxy-fetch van 'student' naar 'opstartsessie'.
--
-- Scoring (dfo-website leest dit):
--   - Één gekozen optie met afwijzer=true → resultaat 'afgewezen'.
--   - Anders: som(punten) >= drempel (9) → 'toegelaten', anders 'afgewezen'.
--   - Knock-outs alleen op V4 (werkzoekend), V5 (alleen signalen),
--     V6 (iets gratis).
--
-- Idempotent: ON CONFLICT (slug) DO UPDATE op quiz; DELETE + INSERT op
-- vragen (nieuwe id's — publicatie snapshot maakt versie N+1 aan zodat
-- oude versies + hun antwoord-referenties bewaard blijven).
--
-- 0 incasso-writes. Incasso-zone (finance.html, *dunning*, *arrangement*,
-- pending-action*, _lib/dunning-*) onaangeroerd.
-- ============================================================================

BEGIN;

-- ── 1. Quiz-row upsert ────────────────────────────────────────────────────
INSERT INTO public.website_quizzes (slug, naam, drempel, is_active)
VALUES ('opstartsessie', 'Opstartsessie kwalificatie', 9, true)
ON CONFLICT (slug) DO UPDATE SET
  naam       = EXCLUDED.naam,
  drempel    = EXCLUDED.drempel,
  is_active  = EXCLUDED.is_active,
  updated_at = now();

-- ── 2. Oude vragen leeghalen (idempotent bij re-run) ──────────────────────
DELETE FROM public.website_quiz_questions
 WHERE quiz_id = (SELECT id FROM public.website_quizzes WHERE slug = 'opstartsessie');

-- ── 3. Zes vragen inserten in vaste volgorde ──────────────────────────────
INSERT INTO public.website_quiz_questions (quiz_id, order_index, label, options, active)
SELECT q.id, v.order_index, v.label, v.opts::jsonb, true
  FROM public.website_quizzes q,
       (VALUES
         (0, 'Hoe goed ken je traden al?', $json$[
           {"label":"Nog nooit echt mee bezig geweest","punten":0,"afwijzer":false},
           {"label":"Ik heb er weleens over gelezen of video's gekeken","punten":1,"afwijzer":false},
           {"label":"Ik heb al wat geoefend of getraded","punten":2,"afwijzer":false},
           {"label":"Ik trade al actief, maar wil het serieuzer aanpakken","punten":3,"afwijzer":false}
         ]$json$),
         (1, 'Hoeveel tijd kun je er per week voor vrijmaken?', $json$[
           {"label":"Minder dan 2 uur","punten":0,"afwijzer":false},
           {"label":"2 tot 5 uur","punten":1,"afwijzer":false},
           {"label":"5 tot 10 uur","punten":2,"afwijzer":false},
           {"label":"10 uur of meer","punten":3,"afwijzer":false}
         ]$json$),
         (2, 'Wat wil je met traden bereiken?', $json$[
           {"label":"Iets bijverdienen","punten":1,"afwijzer":false},
           {"label":"Een serieus tweede inkomen","punten":2,"afwijzer":false},
           {"label":"Uiteindelijk full-time","punten":3,"afwijzer":false},
           {"label":"Snel geld verdienen","punten":0,"afwijzer":false}
         ]$json$),
         (3, 'Wat is je werk- en inkomenssituatie?', $json$[
           {"label":"In loondienst","punten":2,"afwijzer":false},
           {"label":"Ondernemer / zelfstandige","punten":2,"afwijzer":false},
           {"label":"Gepensioneerd","punten":2,"afwijzer":false},
           {"label":"Student met (bij)baan of eigen inkomen","punten":2,"afwijzer":false},
           {"label":"Werkzoekend / geen eigen inkomen op dit moment","punten":0,"afwijzer":true}
         ]$json$),
         (4, 'Hoe wil je het liefst leren?', $json$[
           {"label":"De methode écht begrijpen","punten":3,"afwijzer":false},
           {"label":"Alleen kant-en-klare signalen volgen","punten":0,"afwijzer":true}
         ]$json$),
         (5, 'Ben je bereid om in jezelf te investeren om traden echt onder de knie te krijgen?', $json$[
           {"label":"Ja, ik zie het als een investering in mezelf","punten":3,"afwijzer":false},
           {"label":"Ja, als ik zie dat het bij me past","punten":2,"afwijzer":false},
           {"label":"Misschien, ik twijfel nog","punten":1,"afwijzer":false},
           {"label":"Nee, ik zoek liever iets gratis","punten":0,"afwijzer":true}
         ]$json$)
       ) AS v(order_index, label, opts)
 WHERE q.slug = 'opstartsessie';

-- ── 4. Vorige publicaties op is_actueel=false zetten (unique index eist 1) ─
UPDATE public.website_quiz_publicaties
   SET is_actueel = false
 WHERE slug = 'opstartsessie'
   AND is_actueel = true;

-- ── 5. Nieuwe publicatie versie N+1 als snapshot van werk-versie ──────────
INSERT INTO public.website_quiz_publicaties (slug, versie, naam, drempel, inhoud, is_actueel)
SELECT
  q.slug,
  COALESCE((SELECT MAX(versie) FROM public.website_quiz_publicaties WHERE slug = 'opstartsessie'), 0) + 1,
  q.naam,
  q.drempel,
  COALESCE((
    SELECT jsonb_agg(
             jsonb_build_object(
               'id',          qq.id,
               'order_index', qq.order_index,
               'label',       qq.label,
               'options',     qq.options
             )
             ORDER BY qq.order_index
           )
      FROM public.website_quiz_questions qq
     WHERE qq.quiz_id = q.id
       AND qq.active
  ), '[]'::jsonb),
  true
FROM public.website_quizzes q
WHERE q.slug = 'opstartsessie';

COMMIT;

-- Reload PostgREST schema cache voor nieuwe data (anon-fetch werkt anders niet direct).
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- VERIFICATIE (draai NA COMMIT)
-- ============================================================================
-- 1. Quiz + vragen:
--    SELECT q.slug, q.naam, q.drempel, q.is_active, COUNT(qq.id) AS n_vragen
--      FROM public.website_quizzes q
--      LEFT JOIN public.website_quiz_questions qq ON qq.quiz_id = q.id AND qq.active
--     WHERE q.slug = 'opstartsessie'
--     GROUP BY q.slug, q.naam, q.drempel, q.is_active;
--    Verwacht: opstartsessie | Opstartsessie kwalificatie | 9 | true | 6.
--
-- 2. Opties per vraag:
--    SELECT order_index, label, jsonb_array_length(options) AS n_opties
--      FROM public.website_quiz_questions
--     WHERE quiz_id = (SELECT id FROM public.website_quizzes WHERE slug='opstartsessie')
--     ORDER BY order_index;
--    Verwacht: 4 / 4 / 4 / 5 / 2 / 4 opties per vraag.
--
-- 3. Afwijzers (alleen V4, V5, V6):
--    SELECT order_index, label, o->>'label' AS optie, o->>'afwijzer' AS afwijzer
--      FROM public.website_quiz_questions,
--           jsonb_array_elements(options) o
--     WHERE quiz_id = (SELECT id FROM public.website_quizzes WHERE slug='opstartsessie')
--       AND (o->>'afwijzer')::boolean = true
--     ORDER BY order_index;
--    Verwacht: 3 rijen (V4 werkzoekend, V5 signalen, V6 gratis).
--
-- 4. Publicatie live:
--    SELECT slug, versie, drempel, jsonb_array_length(inhoud) AS n_vragen, is_actueel
--      FROM public.website_quiz_publicaties
--     WHERE slug = 'opstartsessie' AND is_actueel = true;
--    Verwacht: 1 rij met versie 1 (of hoger bij re-run), drempel 9, n_vragen 6.
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- Ongedaan maken (verwijdert de nieuwe slug volledig — antwoord-referenties in
-- opstartsessie_submissions blijven bestaan; jsonb-snapshot is immuun).
-- BEGIN;
--   DELETE FROM public.website_quiz_publicaties
--    WHERE slug = 'opstartsessie';
--   DELETE FROM public.website_quiz_questions
--    WHERE quiz_id = (SELECT id FROM public.website_quizzes WHERE slug='opstartsessie');
--   DELETE FROM public.website_quizzes WHERE slug = 'opstartsessie';
-- COMMIT;
-- ============================================================================
