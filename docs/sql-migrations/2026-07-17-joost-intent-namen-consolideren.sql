-- 2026-07-17 — Joost intent-namen consolideren naar LLM-set.
--
-- ACHTERGROND
--   Er waren drie naamsets voor intents:
--     * UI  (finance-instellingen.js JOOST_INTENTS):
--         payment_promise, arrangement_request, dispute, question, unsubscribe, other
--     * LLM (joost-suggest-core.js DETECTED_INTENTS, contract met het model):
--         payment_promise, verify_payment, arrangement_request, general_question,
--         escalation_needed, other
--     * seed (2026-06-09-joost-e2-autonomy-full.sql):
--         ja_op_uitstel, tegenvoorstel_termijn, gespreid_betalen,
--         kan_niet_betalen, al_betaald_claim, boos_of_klacht, vraag_om_kopie_factuur
--
--   De LLM-set is leidend (het is het enige contract dat het model kent). De
--   evaluator brugde de LLM-set naar de seed-set via INTENT_TO_CONFIG_KEY —
--   waardoor UI-instellingen onder een derde set (payment_promise etc.)
--   effectief werden GENEGEERD door de evaluator (die de seed-set las).
--
-- SCOPE: alleen module='finance'. events (Simone) en onboarding hebben
--   eigen intent-sets in hun agent-cores en zijn NIET betrokken.
--
-- WAT DEZE MIGRATIE DOET
--   1. PRE-STATE snapshot in een TEMP-tabel (voor pre/post-vergelijking).
--   2. Rename oude keys naar LLM-set met "UI-waarde wint bij conflict":
--        UI arrangement_request  || seed tegenvoorstel_termijn  -> arrangement_request
--        UI payment_promise      || seed ja_op_uitstel           -> payment_promise
--        seed al_betaald_claim                                    -> verify_payment
--        UI question             || seed vraag_om_kopie_factuur   -> general_question
--        UI dispute              || seed boos_of_klacht           -> escalation_needed
--        UI other                                                 -> other (identity)
--      confidence_threshold / max_messages_per_conv / enabled etc worden
--      compleet meegenomen van de gekozen source-value.
--
--   3. MODE-PRESERVE per intent, met één safety-conversie:
--        source mode = 'disabled'   -> BLIJFT 'disabled' (bewuste keuze
--                                                          klant/beleid;
--                                                          bv. escalation_needed
--                                                          hoort bij een mens,
--                                                          niet bij Joost)
--        source mode = 'draft'      -> blijft 'draft'
--        source mode = 'autonomous' -> WORDT 'draft'      (safety: geen enkel
--                                                          intent mag door de
--                                                          rename autonoom
--                                                          worden)
--        source mode ontbreekt      -> 'draft'            (default)
--
--   4. Dropt de dode keys:
--        - unsubscribe             (UI-key zonder LLM-tegenhanger)
--        - gespreid_betalen        (seed-key; splitsing zit al in arrangement_mandate.splitsing)
--        - kan_niet_betalen        (seed-key zonder LLM-tegenhanger — escalation_needed dekt dit)
--        - dispute / question      (UI-oud, na hun rename)
--        - ja_op_uitstel / tegenvoorstel_termijn / al_betaald_claim /
--          boos_of_klacht / vraag_om_kopie_factuur (seed-oud, na hun rename)
--
--   5. POST-STATE snapshot + 6 asserties. Bij gefaalde assertie:
--      RAISE EXCEPTION → automatische ROLLBACK.
--        A. Geen intent op mode='autonomous'.
--        B. Alle 6 LLM-keys aanwezig.
--        C. Geen enkele oude key over.
--        D. Elke intent die PRE 'disabled' was, is POST 'disabled'.
--        E. Elke intent met PRE confidence_threshold heeft POST identieke waarde.
--        F. Elke intent met PRE max_messages_per_conv heeft POST identieke waarde.
--
-- IDEMPOTENT: bij een 2e run zijn alle nieuwe keys al aanwezig, oude keys al
--   weg. Rename is dan een identity-transformatie; asserties slagen; commit ok.

BEGIN;

-- ===========================================================================
-- 1. PRE-STATE snapshot in TEMP-tabel (ON COMMIT DROP)
-- ===========================================================================
-- Per doel-key: bewaar de EFFECTIEVE source-values (na COALESCE UI-oud →
-- seed-oud). Dit is wat de UPDATE zou gebruiken, en tegelijk waar we de
-- post-state tegenaan gaan verifiëren.
CREATE TEMP TABLE _intent_migration_prestate ON COMMIT DROP AS
WITH cfg AS (
  SELECT autonomy_config -> 'intents' AS intents
    FROM public.joost_config
    WHERE module = 'finance'
)
SELECT 'payment_promise' AS target_key,
       COALESCE(intents -> 'payment_promise' ->> 'mode',
                intents -> 'ja_op_uitstel'    ->> 'mode') AS src_mode,
       COALESCE(intents -> 'payment_promise' ->> 'confidence_threshold',
                intents -> 'ja_op_uitstel'    ->> 'confidence_threshold',
                intents -> 'payment_promise' ->> 'min_confidence',
                intents -> 'ja_op_uitstel'    ->> 'min_confidence') AS src_conf,
       COALESCE(intents -> 'payment_promise' ->> 'max_messages_per_conv',
                intents -> 'ja_op_uitstel'    ->> 'max_messages_per_conv') AS src_maxmsg
FROM cfg
UNION ALL
SELECT 'arrangement_request',
       COALESCE(intents -> 'arrangement_request' ->> 'mode',
                intents -> 'tegenvoorstel_termijn' ->> 'mode'),
       COALESCE(intents -> 'arrangement_request'  ->> 'confidence_threshold',
                intents -> 'tegenvoorstel_termijn' ->> 'confidence_threshold',
                intents -> 'arrangement_request'  ->> 'min_confidence',
                intents -> 'tegenvoorstel_termijn' ->> 'min_confidence'),
       COALESCE(intents -> 'arrangement_request'  ->> 'max_messages_per_conv',
                intents -> 'tegenvoorstel_termijn' ->> 'max_messages_per_conv')
FROM cfg
UNION ALL
SELECT 'verify_payment',
       intents -> 'al_betaald_claim' ->> 'mode',
       COALESCE(intents -> 'al_betaald_claim' ->> 'confidence_threshold',
                intents -> 'al_betaald_claim' ->> 'min_confidence'),
       intents -> 'al_betaald_claim' ->> 'max_messages_per_conv'
FROM cfg
UNION ALL
SELECT 'general_question',
       COALESCE(intents -> 'question' ->> 'mode',
                intents -> 'vraag_om_kopie_factuur' ->> 'mode'),
       COALESCE(intents -> 'question'               ->> 'confidence_threshold',
                intents -> 'vraag_om_kopie_factuur' ->> 'confidence_threshold',
                intents -> 'question'               ->> 'min_confidence',
                intents -> 'vraag_om_kopie_factuur' ->> 'min_confidence'),
       COALESCE(intents -> 'question'               ->> 'max_messages_per_conv',
                intents -> 'vraag_om_kopie_factuur' ->> 'max_messages_per_conv')
FROM cfg
UNION ALL
SELECT 'escalation_needed',
       COALESCE(intents -> 'dispute' ->> 'mode',
                intents -> 'boos_of_klacht' ->> 'mode'),
       COALESCE(intents -> 'dispute'        ->> 'confidence_threshold',
                intents -> 'boos_of_klacht' ->> 'confidence_threshold',
                intents -> 'dispute'        ->> 'min_confidence',
                intents -> 'boos_of_klacht' ->> 'min_confidence'),
       COALESCE(intents -> 'dispute'        ->> 'max_messages_per_conv',
                intents -> 'boos_of_klacht' ->> 'max_messages_per_conv')
FROM cfg
UNION ALL
SELECT 'other',
       intents -> 'other' ->> 'mode',
       COALESCE(intents -> 'other' ->> 'confidence_threshold',
                intents -> 'other' ->> 'min_confidence'),
       intents -> 'other' ->> 'max_messages_per_conv'
FROM cfg;

-- Debug: PRE-state rapportage
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[intent-namen] PRE-state snapshot (effectieve source per doel-key):';
  FOR r IN SELECT * FROM _intent_migration_prestate ORDER BY target_key LOOP
    RAISE NOTICE '  target=%  src_mode=%  src_conf=%  src_maxmsg=%',
      r.target_key,
      COALESCE(r.src_mode,   '(null)'),
      COALESCE(r.src_conf,   '(null)'),
      COALESCE(r.src_maxmsg, '(null)');
    IF r.src_mode = 'autonomous' THEN
      RAISE NOTICE '    ⚠ source-mode is ''autonomous'' — wordt door safety-conversie ''draft'' na de rename.';
    END IF;
  END LOOP;
END $$;

-- ===========================================================================
-- 2. RENAME + MODE-PRESERVE (met safety-conversie autonomous->draft)
-- ===========================================================================
UPDATE public.joost_config AS jc
   SET autonomy_config = jsonb_set(
     COALESCE(autonomy_config, '{}'::jsonb),
     '{intents}',
     (
       WITH src AS (
         SELECT autonomy_config -> 'intents' AS intents
           FROM public.joost_config WHERE module = 'finance'
       ),
       merged AS (
         SELECT jsonb_build_object(
           -- payment_promise: UI payment_promise | seed ja_op_uitstel
           'payment_promise',
             jsonb_set(
               COALESCE(src.intents -> 'payment_promise',
                        src.intents -> 'ja_op_uitstel',
                        '{}'::jsonb),
               '{mode}',
               to_jsonb(
                 CASE COALESCE(src.intents -> 'payment_promise' ->> 'mode',
                               src.intents -> 'ja_op_uitstel'    ->> 'mode', '')
                   WHEN 'disabled' THEN 'disabled'
                   ELSE 'draft'
                 END
               ),
               true
             ),
           -- arrangement_request: UI arrangement_request | seed tegenvoorstel_termijn
           'arrangement_request',
             jsonb_set(
               COALESCE(src.intents -> 'arrangement_request',
                        src.intents -> 'tegenvoorstel_termijn',
                        '{}'::jsonb),
               '{mode}',
               to_jsonb(
                 CASE COALESCE(src.intents -> 'arrangement_request'  ->> 'mode',
                               src.intents -> 'tegenvoorstel_termijn' ->> 'mode', '')
                   WHEN 'disabled' THEN 'disabled'
                   ELSE 'draft'
                 END
               ),
               true
             ),
           -- verify_payment: alleen seed al_betaald_claim
           'verify_payment',
             jsonb_set(
               COALESCE(src.intents -> 'al_betaald_claim', '{}'::jsonb),
               '{mode}',
               to_jsonb(
                 CASE COALESCE(src.intents -> 'al_betaald_claim' ->> 'mode', '')
                   WHEN 'disabled' THEN 'disabled'
                   ELSE 'draft'
                 END
               ),
               true
             ),
           -- general_question: UI question | seed vraag_om_kopie_factuur
           'general_question',
             jsonb_set(
               COALESCE(src.intents -> 'question',
                        src.intents -> 'vraag_om_kopie_factuur',
                        '{}'::jsonb),
               '{mode}',
               to_jsonb(
                 CASE COALESCE(src.intents -> 'question'               ->> 'mode',
                               src.intents -> 'vraag_om_kopie_factuur' ->> 'mode', '')
                   WHEN 'disabled' THEN 'disabled'
                   ELSE 'draft'
                 END
               ),
               true
             ),
           -- escalation_needed: UI dispute | seed boos_of_klacht
           'escalation_needed',
             jsonb_set(
               COALESCE(src.intents -> 'dispute',
                        src.intents -> 'boos_of_klacht',
                        '{}'::jsonb),
               '{mode}',
               to_jsonb(
                 CASE COALESCE(src.intents -> 'dispute'        ->> 'mode',
                               src.intents -> 'boos_of_klacht' ->> 'mode', '')
                   WHEN 'disabled' THEN 'disabled'
                   ELSE 'draft'
                 END
               ),
               true
             ),
           -- other: UI other (identity)
           'other',
             jsonb_set(
               COALESCE(src.intents -> 'other', '{}'::jsonb),
               '{mode}',
               to_jsonb(
                 CASE COALESCE(src.intents -> 'other' ->> 'mode', '')
                   WHEN 'disabled' THEN 'disabled'
                   ELSE 'draft'
                 END
               ),
               true
             )
         ) AS new_intents
         FROM src
       )
       SELECT new_intents FROM merged
     ),
     true
   ),
   updated_at = now()
 WHERE module = 'finance';

-- ===========================================================================
-- 3. POST-STATE + ASSERTIES A/B/C/D/E/F
-- ===========================================================================
DO $$
DECLARE
  v_intents          jsonb;
  v_k                text;
  v_val              jsonb;
  v_autonomous_count int := 0;
  r                  RECORD;
  v_post_val         jsonb;
  v_post_mode        text;
  v_post_conf        text;
  v_post_maxmsg      text;
BEGIN
  SELECT autonomy_config -> 'intents'
    INTO v_intents
    FROM public.joost_config
    WHERE module = 'finance';

  RAISE NOTICE '[intent-namen] POST-state (na rename):';
  FOR v_k IN SELECT jsonb_object_keys(v_intents) LOOP
    v_val := v_intents -> v_k;
    RAISE NOTICE '  intent=%  mode=%  confidence=%  max_msg=%',
      v_k,
      COALESCE(v_val->>'mode', '(null)'),
      COALESCE(v_val->>'confidence_threshold', v_val->>'min_confidence', '(null)'),
      COALESCE(v_val->>'max_messages_per_conv', '(null)');
    IF v_val->>'mode' = 'autonomous' THEN
      v_autonomous_count := v_autonomous_count + 1;
    END IF;
  END LOOP;

  -- ---- ASSERTIE A: geen enkele intent mag op autonomous staan. --------------
  IF v_autonomous_count > 0 THEN
    RAISE EXCEPTION '[intent-namen] ASSERTIE A FOUT: % intent(s) op mode=autonomous. ROLLBACK.', v_autonomous_count;
  END IF;

  -- ---- ASSERTIE B: alle 6 LLM-keys aanwezig. --------------------------------
  FOR v_k IN SELECT k FROM (VALUES
    ('payment_promise'), ('verify_payment'), ('arrangement_request'),
    ('general_question'), ('escalation_needed'), ('other')
  ) AS t(k) LOOP
    IF NOT (v_intents ? v_k) THEN
      RAISE EXCEPTION '[intent-namen] ASSERTIE B FOUT: LLM-key % ontbreekt. ROLLBACK.', v_k;
    END IF;
  END LOOP;

  -- ---- ASSERTIE C: geen enkele oude key over. -------------------------------
  FOR v_k IN SELECT k FROM (VALUES
    ('ja_op_uitstel'), ('tegenvoorstel_termijn'), ('gespreid_betalen'),
    ('kan_niet_betalen'), ('al_betaald_claim'), ('boos_of_klacht'),
    ('vraag_om_kopie_factuur'), ('dispute'), ('question'), ('unsubscribe')
  ) AS t(k) LOOP
    IF v_intents ? v_k THEN
      RAISE EXCEPTION '[intent-namen] ASSERTIE C FOUT: oude key % bestaat nog. ROLLBACK.', v_k;
    END IF;
  END LOOP;

  -- ---- ASSERTIES D/E/F: pre/post-vergelijking per doel-key. -----------------
  FOR r IN SELECT * FROM _intent_migration_prestate LOOP
    v_post_val    := v_intents -> r.target_key;
    v_post_mode   := v_post_val ->> 'mode';
    v_post_conf   := COALESCE(v_post_val ->> 'confidence_threshold',
                              v_post_val ->> 'min_confidence');
    v_post_maxmsg := v_post_val ->> 'max_messages_per_conv';

    -- D: was PRE 'disabled', moet POST 'disabled' zijn.
    IF r.src_mode = 'disabled' AND COALESCE(v_post_mode, '') <> 'disabled' THEN
      RAISE EXCEPTION
        '[intent-namen] ASSERTIE D FOUT: % was PRE ''disabled'', POST is ''%''. mode-preserve gefaald. ROLLBACK.',
        r.target_key, COALESCE(v_post_mode, '(null)');
    END IF;

    -- E: confidence_threshold moet behouden blijven als 'ie in PRE bestond.
    IF r.src_conf IS NOT NULL AND COALESCE(v_post_conf, '') <> r.src_conf THEN
      RAISE EXCEPTION
        '[intent-namen] ASSERTIE E FOUT: % PRE confidence=% POST confidence=%. Waarde-preserve gefaald. ROLLBACK.',
        r.target_key, r.src_conf, COALESCE(v_post_conf, '(null)');
    END IF;

    -- F: max_messages_per_conv moet behouden blijven als 'ie in PRE bestond.
    IF r.src_maxmsg IS NOT NULL AND COALESCE(v_post_maxmsg, '') <> r.src_maxmsg THEN
      RAISE EXCEPTION
        '[intent-namen] ASSERTIE F FOUT: % PRE max_msg=% POST max_msg=%. Waarde-preserve gefaald. ROLLBACK.',
        r.target_key, r.src_maxmsg, COALESCE(v_post_maxmsg, '(null)');
    END IF;
  END LOOP;

  RAISE NOTICE '[intent-namen] Alle 6 asserties (A/B/C/D/E/F) geslaagd. Geen autonomous, disabled-modes behouden, confidence + max_msg intact.';
END $$;

COMMIT;
