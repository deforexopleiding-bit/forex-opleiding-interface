-- 2026-07-17 — Joost intent-namen: VERIFY-FIRST (READ-ONLY).
--
-- Doel: laat zien WAT er nu in autonomy_config.intents staat voor ALLE
--   modules (finance, events, onboarding). Puur SELECT — muteert niets.
--
-- BELANGRIJK: alleen module='finance' wordt door de rename-migratie geraakt.
--   events (Simone) en onboarding hebben EIGEN intent-sets in hun agent-cores:
--     * simone-suggest-core.js DETECTED_INTENTS_EVENTS
--         (event_info, date_location, registration_intent, cancel_or_reschedule,
--          logistics, escalation_needed, general_question, other)
--     * onboarding-agent-core.js DETECTED_INTENTS_ONBOARDING
--         (wizard_help, access_login, community_question, content_question,
--          mentor_contact, logistics, escalation_needed, general_question, other)
--   Deze query toont ze zodat je kunt bevestigen dat ze niet per ongeluk
--   mee-gemigreerd worden.
--
-- Draai in Supabase SQL Editor (of psql) VOOR de rename-migratie
-- (2026-07-17-joost-intent-namen-consolideren.sql).
--
-- Wat te controleren in de output:
--   1. **Bestaande modes per intent voor module='finance'.** Elke intent
--      met mode='disabled' MOET na de rename OOK 'disabled' zijn (de migratie
--      assertert dit). Als mode='draft' of NULL → wordt 'draft'. Als 'autonomous'
--      → wordt 'draft' (bewuste safety-conversie; wordt in de RAISE NOTICE
--      expliciet gemeld).
--   2. **confidence_threshold + max_messages_per_conv per intent.** Deze
--      waarden werden tot nu toe door de mapping-bug genegeerd — na de
--      rename worden ze voor het eerst ECHT gelezen. Ze mogen NIET sneuvelen
--      bij de rename. Vergelijk pre/post en post moet identiek zijn.
--   3. **events/onboarding-rijen.** Als daar keys staan die overlappen met
--      de finance-oude keys (zeer onwaarschijnlijk — de sets zijn disjunct),
--      meld het. Anders: gewoon informatief zichtbaar.
--
-- LET OP: pure SELECT — geen BEGIN/ROLLBACK. Supabase SQL editor draait elke
-- statement in een eigen transactie; deze 3 queries zijn puur lees en kunnen
-- afzonderlijk worden gedraaid als het editor-scherm ze niet gecombineerd
-- accepteert.


-- ===========================================================================
-- 1. Overzicht ALLE modules — welke intent-keys bestaan, welke mode, welke
--    waarden. Onafhankelijk van de module.
-- ===========================================================================
WITH cfg AS (
  SELECT module, autonomy_config
    FROM public.joost_config
)
SELECT
  c.module,
  ik.intent_key,
  c.autonomy_config -> 'intents' -> ik.intent_key ->> 'mode'                  AS mode,
  c.autonomy_config -> 'intents' -> ik.intent_key ->> 'confidence_threshold'  AS confidence_threshold,
  c.autonomy_config -> 'intents' -> ik.intent_key ->> 'min_confidence'        AS min_confidence,
  c.autonomy_config -> 'intents' -> ik.intent_key ->> 'enabled'               AS enabled_flag,
  c.autonomy_config -> 'intents' -> ik.intent_key ->> 'max_messages_per_conv' AS max_messages_per_conv,
  c.autonomy_config -> 'intents' -> ik.intent_key                              AS full_value
FROM cfg c
CROSS JOIN LATERAL jsonb_object_keys(COALESCE(c.autonomy_config -> 'intents', '{}'::jsonb)) AS ik(intent_key)
ORDER BY c.module, ik.intent_key;

-- ===========================================================================
-- 2. Finance-specifiek: alle 16 mogelijke intent-keys (LLM-nieuw + UI-oud +
--    seed-oud) naast elkaar, ook als ze niet bestaan (NULL row).
-- ===========================================================================
WITH cfg AS (
  SELECT autonomy_config
    FROM public.joost_config
   WHERE module = 'finance'
),
llm_set(intent_key, source_expected) AS (VALUES
  ('payment_promise',     'LLM (nieuw)'),
  ('verify_payment',      'LLM (nieuw)'),
  ('arrangement_request', 'LLM (nieuw)'),
  ('general_question',    'LLM (nieuw)'),
  ('escalation_needed',   'LLM (nieuw)'),
  ('other',               'LLM (nieuw)')
),
old_ui_set(intent_key, source_expected) AS (VALUES
  ('dispute',     'UI (oud)'),
  ('question',    'UI (oud)'),
  ('unsubscribe', 'UI (oud)')
),
old_seed_set(intent_key, source_expected) AS (VALUES
  ('ja_op_uitstel',          'seed (oud)'),
  ('tegenvoorstel_termijn',  'seed (oud)'),
  ('gespreid_betalen',       'seed (oud)'),
  ('kan_niet_betalen',       'seed (oud)'),
  ('al_betaald_claim',       'seed (oud)'),
  ('boos_of_klacht',         'seed (oud)'),
  ('vraag_om_kopie_factuur', 'seed (oud)')
),
all_keys AS (
  SELECT * FROM llm_set
  UNION ALL SELECT * FROM old_ui_set
  UNION ALL SELECT * FROM old_seed_set
)
SELECT
  ak.intent_key,
  ak.source_expected,
  CASE
    WHEN (cfg.autonomy_config -> 'intents' -> ak.intent_key) IS NULL THEN 'NIET AANWEZIG'
    ELSE 'aanwezig'
  END                                                                        AS status,
  cfg.autonomy_config -> 'intents' -> ak.intent_key ->> 'mode'                AS mode,
  cfg.autonomy_config -> 'intents' -> ak.intent_key ->> 'confidence_threshold' AS confidence_threshold,
  cfg.autonomy_config -> 'intents' -> ak.intent_key ->> 'min_confidence'      AS min_confidence,
  cfg.autonomy_config -> 'intents' -> ak.intent_key ->> 'enabled'             AS enabled_flag,
  cfg.autonomy_config -> 'intents' -> ak.intent_key ->> 'max_messages_per_conv' AS max_messages_per_conv,
  cfg.autonomy_config -> 'intents' -> ak.intent_key                            AS full_value
FROM all_keys ak
CROSS JOIN cfg
ORDER BY
  CASE ak.source_expected
    WHEN 'LLM (nieuw)' THEN 1
    WHEN 'UI (oud)'    THEN 2
    WHEN 'seed (oud)'  THEN 3
    ELSE 4
  END,
  ak.intent_key;

-- ===========================================================================
-- 3. Preview: welke finance-intents zouden na de rename op mode='disabled'
--    moeten blijven? Dat helpt vergelijken met de POST-state.
-- ===========================================================================
WITH cfg AS (
  SELECT autonomy_config -> 'intents' AS intents
    FROM public.joost_config WHERE module = 'finance'
)
SELECT
  'payment_promise' AS target_key,
  COALESCE(intents -> 'payment_promise' ->> 'mode', intents -> 'ja_op_uitstel' ->> 'mode') AS source_mode,
  CASE WHEN COALESCE(intents -> 'payment_promise' ->> 'mode', intents -> 'ja_op_uitstel' ->> 'mode') = 'disabled'
       THEN 'disabled (behoud)' ELSE 'draft (default of autonomous->draft)' END AS post_mode_expected
FROM cfg
UNION ALL
SELECT
  'arrangement_request',
  COALESCE(intents -> 'arrangement_request' ->> 'mode', intents -> 'tegenvoorstel_termijn' ->> 'mode'),
  CASE WHEN COALESCE(intents -> 'arrangement_request' ->> 'mode', intents -> 'tegenvoorstel_termijn' ->> 'mode') = 'disabled'
       THEN 'disabled (behoud)' ELSE 'draft (default of autonomous->draft)' END
FROM cfg
UNION ALL
SELECT
  'verify_payment',
  intents -> 'al_betaald_claim' ->> 'mode',
  CASE WHEN intents -> 'al_betaald_claim' ->> 'mode' = 'disabled'
       THEN 'disabled (behoud)' ELSE 'draft (default of autonomous->draft)' END
FROM cfg
UNION ALL
SELECT
  'general_question',
  COALESCE(intents -> 'question' ->> 'mode', intents -> 'vraag_om_kopie_factuur' ->> 'mode'),
  CASE WHEN COALESCE(intents -> 'question' ->> 'mode', intents -> 'vraag_om_kopie_factuur' ->> 'mode') = 'disabled'
       THEN 'disabled (behoud)' ELSE 'draft (default of autonomous->draft)' END
FROM cfg
UNION ALL
SELECT
  'escalation_needed',
  COALESCE(intents -> 'dispute' ->> 'mode', intents -> 'boos_of_klacht' ->> 'mode'),
  CASE WHEN COALESCE(intents -> 'dispute' ->> 'mode', intents -> 'boos_of_klacht' ->> 'mode') = 'disabled'
       THEN 'disabled (behoud)' ELSE 'draft (default of autonomous->draft)' END
FROM cfg
UNION ALL
SELECT
  'other',
  intents -> 'other' ->> 'mode',
  CASE WHEN intents -> 'other' ->> 'mode' = 'disabled'
       THEN 'disabled (behoud)' ELSE 'draft (default of autonomous->draft)' END
FROM cfg;

