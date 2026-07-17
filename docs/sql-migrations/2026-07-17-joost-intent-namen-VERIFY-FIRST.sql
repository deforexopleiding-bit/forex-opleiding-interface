-- 2026-07-17 — Joost intent-namen: VERIFY-FIRST (READ-ONLY).
--
-- Doel: laat zien WAT er nu in autonomy_config.intents staat voor
--   module='finance', zodat we vóór de rename-migratie zeker weten wat er
--   overschreven wordt. Puur SELECT — muteert niets.
--
-- Draai deze query in Supabase SQL Editor (of psql) BEFORE de rename-migratie
-- (2026-07-17-joost-intent-namen-consolideren.sql).
--
-- Verwachte kolommen:
--   * intent_key        — één rij per intent-key die op dit moment bestaat
--   * source            — 'UI' | 'seed' | 'onbekend'
--   * mode              — draft/autonomous/disabled/null
--   * confidence        — number|null
--   * max_messages      — number|null (alleen UI-keys hebben dit veld)
--   * full_value        — de complete jsonb-inhoud voor debug
--
-- Wat te doen met de output:
--   1. Als 'mode'-kolom ergens 'autonomous' toont, RAPPORTEER dat aan Jeffrey.
--      De rename-migratie forceert alles op 'draft' — dus als er ergens
--      autonomous stond wordt dat teruggezet. Waarschijnlijk gewenst
--      (Jeffrey zei "alles staat op draft"), maar bevestig.
--   2. Als voor 'arrangement_request' zowel de UI-key ALS de seed-key
--      'tegenvoorstel_termijn' bestaat: de UI-waarde wint bij de migratie
--      (zoals afgesproken). Idem 'dispute' vs 'boos_of_klacht',
--      'question' vs 'vraag_om_kopie_factuur'.
--   3. 'unsubscribe' / 'gespreid_betalen' / 'kan_niet_betalen' worden gedropt.
--      Als daar niet-default waarden in staan (bv. custom confidence): meld
--      dat expliciet voordat we droppen.

BEGIN;

WITH cfg AS (
  SELECT autonomy_config
    FROM public.joost_config
   WHERE module = 'finance'
),
llm_set(intent_key) AS (
  VALUES
    ('payment_promise'),
    ('verify_payment'),
    ('arrangement_request'),
    ('general_question'),
    ('escalation_needed'),
    ('other')
),
old_ui_set(intent_key) AS (
  -- Dode UI-keys uit finance-instellingen.js JOOST_INTENTS
  VALUES ('dispute'), ('question'), ('unsubscribe')
),
old_seed_set(intent_key) AS (
  -- Seed-keys uit 2026-06-09-joost-e2-autonomy-full.sql
  VALUES
    ('ja_op_uitstel'),
    ('tegenvoorstel_termijn'),
    ('gespreid_betalen'),
    ('kan_niet_betalen'),
    ('al_betaald_claim'),
    ('boos_of_klacht'),
    ('vraag_om_kopie_factuur')
),
all_keys AS (
  SELECT intent_key, 'LLM (nieuw)' AS source_expected FROM llm_set
  UNION ALL
  SELECT intent_key, 'UI (oud)'   FROM old_ui_set
  UNION ALL
  SELECT intent_key, 'seed (oud)' FROM old_seed_set
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

-- Aanvullende quick-check: telling per mode. Als hier iets op autonomous
-- staat, waarschuwt de rename-migratie er ook expliciet voor.
SELECT
  jsonb_object_keys(autonomy_config -> 'intents')            AS intent_key,
  autonomy_config -> 'intents' -> jsonb_object_keys(autonomy_config -> 'intents') ->> 'mode' AS mode
FROM public.joost_config
WHERE module = 'finance';

ROLLBACK;
