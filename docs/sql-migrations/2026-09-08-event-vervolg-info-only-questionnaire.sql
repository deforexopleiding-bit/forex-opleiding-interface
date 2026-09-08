-- ============================================================================
-- STAP 2 — INFO-ONLY vervolgvragenlijst 'event-vervolg'
-- Datum: 2026-09-08
--
-- Doel: een APARTE, niet-actieve, INFO-ONLY vragenlijst naast de bestaande
-- gescoorde (basis/gevorderd) questionnaire. De oude GHL/Webflow-route gebruikt
-- de ACTIEVE (is_active=true) questionnaire; die laten we volledig met rust.
-- Deze nieuwe rij staat op is_active=FALSE (de partial-unique 'one_active'
-- blijft dus intact) en info_only=TRUE, en wordt alleen expliciet-op-id
-- aangesproken door de Stap-2-endpoints (event-vervolg-context/-finalize).
--
-- OUDE-FLOW-VEILIG:
--   - Verandert de actieve questionnaire NIET (blijft is_active=true).
--   - Voegt alleen een kolom (info_only) + een nieuwe questionnaire-rij +
--     nieuwe vragen (eigen keys, prefix 'vervolg_') toe.
--   - Raakt geen bestaande assessment_questions.
--
-- NB: draai na deze DDL "NOTIFY pgrst, 'reload schema';" (of Reload schema
--     cache in het dashboard) zodat de nieuwe kolom in de PostgREST-cache komt.
--
-- Idempotent: IF NOT EXISTS / ON CONFLICT.
-- ============================================================================

BEGIN;

-- 1) info_only-vlag op questionnaires (default false → oude rij ongewijzigd).
ALTER TABLE public.assessment_questionnaires
  ADD COLUMN IF NOT EXISTS info_only boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.assessment_questionnaires.info_only IS
  'true = INFO-ONLY vervolgvragenlijst (niet gescoord, geen pass/reject, geen annulering). Wordt expliciet op id aangesproken door de Stap-2-endpoints; NOOIT is_active=true.';

-- 2) De vervolg-questionnaire (niet actief, info-only).
INSERT INTO public.assessment_questionnaires (slug, name, is_active, info_only)
VALUES ('event-vervolg', 'Event vervolgvragen (definitief maken)', false, true)
ON CONFLICT (slug) DO UPDATE SET
  name      = EXCLUDED.name,
  info_only = true,
  updated_at = now();

-- 3) Startset vragen (info-only, is_routing=false). Eigen keys (prefix
--    'vervolg_') zodat de globale UNIQUE(key) niet botst met de bestaande set.
--    Idempotent op key (ON CONFLICT (key) DO NOTHING).
INSERT INTO public.assessment_questions
  (questionnaire_id, key, section, order_index, page, type, label, help_text, required, options, min_words, is_routing, active)
SELECT q.id, v.key, 'vervolg', v.order_index, 1, v.type, v.label, v.help_text, v.required, v.options, v.min_words, false, true
FROM public.assessment_questionnaires q,
     (VALUES
       ('vervolg_ervaring', 100, 'radio',
        'Hoeveel ervaring heb je met traden?', NULL, true,
        '[{"value":"geen","label":"Nog geen"},{"value":"<1jr","label":"Minder dan 1 jaar"},{"value":"1-3jr","label":"1 tot 3 jaar"},{"value":">3jr","label":"Meer dan 3 jaar"}]'::jsonb, NULL::int),

       ('vervolg_echtgeld', 200, 'radio',
        'Handel je op dit moment al met echt geld?', NULL, true,
        '[{"value":"nee","label":"Nee, nog niet"},{"value":"demo","label":"Alleen op demo"},{"value":"klein","label":"Ja, met kleine bedragen"},{"value":"serieus","label":"Ja, serieus"}]'::jsonb, NULL::int),

       ('vervolg_platform', 300, 'text',
        'Welk platform of welke broker gebruik je (indien van toepassing)?', 'Bijv. MetaTrader, TradingView, of de naam van je broker.', false,
        NULL::jsonb, NULL::int),

       ('vervolg_doelen', 400, 'open_text',
        'Wat wil je vooral uit deze masterclass halen?', 'Hoe concreter, hoe beter we je kunnen helpen (minstens 15 woorden).', true,
        NULL::jsonb, 15),

       ('vervolg_doel', 500, 'radio',
        'Wat is je belangrijkste doel met traden?', NULL, true,
        '[{"value":"bijverdienen","label":"Iets bijverdienen"},{"value":"tweede_inkomen","label":"Een tweede inkomen"},{"value":"voltijds","label":"Uiteindelijk voltijds"},{"value":"vermogen","label":"Vermogen opbouwen"},{"value":"anders","label":"Anders"}]'::jsonb, NULL::int),

       ('vervolg_onderwerpen', 600, 'open_text',
        'Zijn er specifieke onderwerpen die je zeker behandeld wilt zien?', 'Optioneel — laat het ons weten.', false,
        NULL::jsonb, NULL::int),

       ('vervolg_tijd', 700, 'radio',
        'Hoeveel tijd per week kun je vrijmaken om te oefenen?', NULL, true,
        '[{"value":"<2u","label":"Minder dan 2 uur"},{"value":"2-5u","label":"2 tot 5 uur"},{"value":"5-10u","label":"5 tot 10 uur"},{"value":">10u","label":"Meer dan 10 uur"}]'::jsonb, NULL::int),

       ('vervolg_herkomst', 800, 'radio',
        'Hoe ben je bij De Forex Opleiding terechtgekomen?', NULL, false,
        '[{"value":"instagram","label":"Instagram"},{"value":"youtube","label":"YouTube"},{"value":"google","label":"Google"},{"value":"via_via","label":"Via via"},{"value":"anders","label":"Anders"}]'::jsonb, NULL::int)
     ) AS v(key, order_index, type, label, help_text, required, options, min_words)
WHERE q.slug = 'event-vervolg'
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- ============================================================================
-- Verificatie:
--   SELECT id, slug, is_active, info_only FROM public.assessment_questionnaires WHERE slug='event-vervolg';
--   SELECT count(*) FROM public.assessment_questions
--     WHERE questionnaire_id=(SELECT id FROM public.assessment_questionnaires WHERE slug='event-vervolg');  -- 8
--   -- De ACTIEVE (oude) questionnaire moet ongemoeid is_active=true blijven:
--   SELECT slug, is_active FROM public.assessment_questionnaires WHERE is_active=true;
-- Vergeet niet:  NOTIFY pgrst, 'reload schema';
-- ============================================================================
