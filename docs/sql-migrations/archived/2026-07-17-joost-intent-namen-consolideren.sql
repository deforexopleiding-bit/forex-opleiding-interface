-- ⛔ NIET DRAAIEN
-- Deze migratie is nooit nodig geweest: productie had 0 oude intent-sleutels.
-- De code-fix uit #792 (INTENT_TO_CONFIG_KEY weg) volstaat.
-- De eerste versie draaide GEDEELTELIJK in de Supabase SQL-editor (TEMP TABLE
-- + meerdere DO-blocks worden daar los uitgevoerd) en overschreef
-- productieconfig: escalation_needed disabled → draft, general_question
-- verloor confidence_threshold 0.75. Handmatig hersteld op 17-07-2026.
-- Les: geen TEMP-tabellen of meerdere DO-blocks in migraties die via de
-- Supabase-editor gedraaid worden.

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
-- DEZE VERSIE: één DO-block. Supabase SQL editor draait elke statement in
--   een aparte transactie, dus TEMP TABLE ... ON COMMIT DROP werkt niet.
--   Alle logica (PRE-snapshot in jsonb-variabele → UPDATE → POST-asserties)
--   zit hier in één PL/pgSQL blok. Bij een RAISE EXCEPTION rolt PostgreSQL
--   automatisch alles binnen het blok terug — geen halve migratie mogelijk.
--
-- WAT DEZE MIGRATIE DOET
--   1. PRE-STATE snapshot in `v_pre_snap` (jsonb).
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
--      RAISE EXCEPTION → automatische ROLLBACK van dit blok.
--        A. Geen intent op mode='autonomous'.
--        B. Alle 6 LLM-keys aanwezig.
--        C. Geen enkele oude key over.
--        D. Elke intent die PRE 'disabled' was, is POST 'disabled'.
--        E. Elke intent met PRE confidence_threshold heeft POST identieke waarde.
--        F. Elke intent met PRE max_messages_per_conv heeft POST identieke waarde.
--
-- IDEMPOTENT: bij een 2e run zijn alle nieuwe keys al aanwezig, oude keys al
--   weg. Rename is dan een identity-transformatie; asserties slagen; block ok.

DO $$
DECLARE
  v_pre_intents      jsonb;
  v_pre_snap         jsonb;
  v_post_intents     jsonb;
  v_k                text;
  v_target           text;
  v_val              jsonb;
  v_pre_mode         text;
  v_pre_conf         text;
  v_pre_maxmsg       text;
  v_post_val         jsonb;
  v_post_mode        text;
  v_post_conf        text;
  v_post_maxmsg      text;
  v_autonomous_count int := 0;
BEGIN
  -- ===========================================================================
  -- 1. PRE-STATE
  -- ===========================================================================
  SELECT autonomy_config -> 'intents'
    INTO v_pre_intents
    FROM public.joost_config
    WHERE module = 'finance';

  IF v_pre_intents IS NULL THEN
    RAISE NOTICE '[intent-namen] PRE-state: intents-object bestaat niet voor finance. Niets te migreren.';
    RETURN;
  END IF;

  -- Bouw PRE-snapshot per doel-key op basis van de effectieve source
  -- (UI-oud eerst, seed-oud als fallback — precies wat de UPDATE gebruikt).
  v_pre_snap := jsonb_build_object(
    'payment_promise', jsonb_build_object(
      'mode',   COALESCE(v_pre_intents->'payment_promise'->>'mode',
                         v_pre_intents->'ja_op_uitstel'   ->>'mode'),
      'conf',   COALESCE(v_pre_intents->'payment_promise'->>'confidence_threshold',
                         v_pre_intents->'ja_op_uitstel'   ->>'confidence_threshold',
                         v_pre_intents->'payment_promise'->>'min_confidence',
                         v_pre_intents->'ja_op_uitstel'   ->>'min_confidence'),
      'maxmsg', COALESCE(v_pre_intents->'payment_promise'->>'max_messages_per_conv',
                         v_pre_intents->'ja_op_uitstel'   ->>'max_messages_per_conv')
    ),
    'arrangement_request', jsonb_build_object(
      'mode',   COALESCE(v_pre_intents->'arrangement_request' ->>'mode',
                         v_pre_intents->'tegenvoorstel_termijn'->>'mode'),
      'conf',   COALESCE(v_pre_intents->'arrangement_request'  ->>'confidence_threshold',
                         v_pre_intents->'tegenvoorstel_termijn'->>'confidence_threshold',
                         v_pre_intents->'arrangement_request'  ->>'min_confidence',
                         v_pre_intents->'tegenvoorstel_termijn'->>'min_confidence'),
      'maxmsg', COALESCE(v_pre_intents->'arrangement_request'  ->>'max_messages_per_conv',
                         v_pre_intents->'tegenvoorstel_termijn'->>'max_messages_per_conv')
    ),
    'verify_payment', jsonb_build_object(
      'mode',   v_pre_intents->'al_betaald_claim'->>'mode',
      'conf',   COALESCE(v_pre_intents->'al_betaald_claim'->>'confidence_threshold',
                         v_pre_intents->'al_betaald_claim'->>'min_confidence'),
      'maxmsg', v_pre_intents->'al_betaald_claim'->>'max_messages_per_conv'
    ),
    'general_question', jsonb_build_object(
      'mode',   COALESCE(v_pre_intents->'question'              ->>'mode',
                         v_pre_intents->'vraag_om_kopie_factuur'->>'mode'),
      'conf',   COALESCE(v_pre_intents->'question'              ->>'confidence_threshold',
                         v_pre_intents->'vraag_om_kopie_factuur'->>'confidence_threshold',
                         v_pre_intents->'question'              ->>'min_confidence',
                         v_pre_intents->'vraag_om_kopie_factuur'->>'min_confidence'),
      'maxmsg', COALESCE(v_pre_intents->'question'              ->>'max_messages_per_conv',
                         v_pre_intents->'vraag_om_kopie_factuur'->>'max_messages_per_conv')
    ),
    'escalation_needed', jsonb_build_object(
      'mode',   COALESCE(v_pre_intents->'dispute'       ->>'mode',
                         v_pre_intents->'boos_of_klacht'->>'mode'),
      'conf',   COALESCE(v_pre_intents->'dispute'       ->>'confidence_threshold',
                         v_pre_intents->'boos_of_klacht'->>'confidence_threshold',
                         v_pre_intents->'dispute'       ->>'min_confidence',
                         v_pre_intents->'boos_of_klacht'->>'min_confidence'),
      'maxmsg', COALESCE(v_pre_intents->'dispute'       ->>'max_messages_per_conv',
                         v_pre_intents->'boos_of_klacht'->>'max_messages_per_conv')
    ),
    'other', jsonb_build_object(
      'mode',   v_pre_intents->'other'->>'mode',
      'conf',   COALESCE(v_pre_intents->'other'->>'confidence_threshold',
                         v_pre_intents->'other'->>'min_confidence'),
      'maxmsg', v_pre_intents->'other'->>'max_messages_per_conv'
    )
  );

  -- Debug: PRE-state rapportage (alle bestaande keys onder hun huidige naam).
  RAISE NOTICE '[intent-namen] PRE-state (huidige intents-blob):';
  FOR v_k IN SELECT jsonb_object_keys(v_pre_intents) LOOP
    v_val := v_pre_intents -> v_k;
    RAISE NOTICE '  intent=%  mode=%  confidence=%  max_msg=%',
      v_k,
      COALESCE(v_val->>'mode', '(null)'),
      COALESCE(v_val->>'confidence_threshold', v_val->>'min_confidence', '(null)'),
      COALESCE(v_val->>'max_messages_per_conv', '(null)');
  END LOOP;

  -- Debug: PRE-snapshot per doel-key (na COALESCE UI-oud → seed-oud).
  RAISE NOTICE '[intent-namen] PRE-snapshot (effectieve source per doel-key):';
  FOR v_target IN SELECT jsonb_object_keys(v_pre_snap) LOOP
    v_pre_mode   := v_pre_snap -> v_target ->> 'mode';
    v_pre_conf   := v_pre_snap -> v_target ->> 'conf';
    v_pre_maxmsg := v_pre_snap -> v_target ->> 'maxmsg';
    RAISE NOTICE '  target=%  src_mode=%  src_conf=%  src_maxmsg=%',
      v_target,
      COALESCE(v_pre_mode,   '(null)'),
      COALESCE(v_pre_conf,   '(null)'),
      COALESCE(v_pre_maxmsg, '(null)');
    IF v_pre_mode = 'autonomous' THEN
      RAISE NOTICE '    ⚠ source-mode is ''autonomous'' — wordt door safety-conversie ''draft'' na de rename.';
    END IF;
  END LOOP;

  -- ===========================================================================
  -- 2. RENAME + MODE-PRESERVE (met safety-conversie autonomous->draft)
  -- ===========================================================================
  UPDATE public.joost_config AS jc
     SET autonomy_config = jsonb_set(
       COALESCE(jc.autonomy_config, '{}'::jsonb),
       '{intents}',
       jsonb_build_object(
         -- payment_promise: UI payment_promise | seed ja_op_uitstel
         'payment_promise',
           jsonb_set(
             COALESCE(v_pre_intents -> 'payment_promise',
                      v_pre_intents -> 'ja_op_uitstel',
                      '{}'::jsonb),
             '{mode}',
             to_jsonb(
               CASE COALESCE(v_pre_intents -> 'payment_promise' ->> 'mode',
                             v_pre_intents -> 'ja_op_uitstel'    ->> 'mode', '')
                 WHEN 'disabled' THEN 'disabled' ELSE 'draft'
               END
             ),
             true
           ),
         -- arrangement_request: UI arrangement_request | seed tegenvoorstel_termijn
         'arrangement_request',
           jsonb_set(
             COALESCE(v_pre_intents -> 'arrangement_request',
                      v_pre_intents -> 'tegenvoorstel_termijn',
                      '{}'::jsonb),
             '{mode}',
             to_jsonb(
               CASE COALESCE(v_pre_intents -> 'arrangement_request'  ->> 'mode',
                             v_pre_intents -> 'tegenvoorstel_termijn' ->> 'mode', '')
                 WHEN 'disabled' THEN 'disabled' ELSE 'draft'
               END
             ),
             true
           ),
         -- verify_payment: alleen seed al_betaald_claim
         'verify_payment',
           jsonb_set(
             COALESCE(v_pre_intents -> 'al_betaald_claim', '{}'::jsonb),
             '{mode}',
             to_jsonb(
               CASE COALESCE(v_pre_intents -> 'al_betaald_claim' ->> 'mode', '')
                 WHEN 'disabled' THEN 'disabled' ELSE 'draft'
               END
             ),
             true
           ),
         -- general_question: UI question | seed vraag_om_kopie_factuur
         'general_question',
           jsonb_set(
             COALESCE(v_pre_intents -> 'question',
                      v_pre_intents -> 'vraag_om_kopie_factuur',
                      '{}'::jsonb),
             '{mode}',
             to_jsonb(
               CASE COALESCE(v_pre_intents -> 'question'               ->> 'mode',
                             v_pre_intents -> 'vraag_om_kopie_factuur' ->> 'mode', '')
                 WHEN 'disabled' THEN 'disabled' ELSE 'draft'
               END
             ),
             true
           ),
         -- escalation_needed: UI dispute | seed boos_of_klacht
         'escalation_needed',
           jsonb_set(
             COALESCE(v_pre_intents -> 'dispute',
                      v_pre_intents -> 'boos_of_klacht',
                      '{}'::jsonb),
             '{mode}',
             to_jsonb(
               CASE COALESCE(v_pre_intents -> 'dispute'        ->> 'mode',
                             v_pre_intents -> 'boos_of_klacht' ->> 'mode', '')
                 WHEN 'disabled' THEN 'disabled' ELSE 'draft'
               END
             ),
             true
           ),
         -- other: UI other (identity)
         'other',
           jsonb_set(
             COALESCE(v_pre_intents -> 'other', '{}'::jsonb),
             '{mode}',
             to_jsonb(
               CASE COALESCE(v_pre_intents -> 'other' ->> 'mode', '')
                 WHEN 'disabled' THEN 'disabled' ELSE 'draft'
               END
             ),
             true
           )
       ),
       true
     ),
     updated_at = now()
   WHERE module = 'finance';

  -- ===========================================================================
  -- 3. POST-STATE + ASSERTIES A/B/C/D/E/F
  -- ===========================================================================
  SELECT autonomy_config -> 'intents'
    INTO v_post_intents
    FROM public.joost_config
    WHERE module = 'finance';

  RAISE NOTICE '[intent-namen] POST-state (na rename):';
  FOR v_k IN SELECT jsonb_object_keys(v_post_intents) LOOP
    v_val := v_post_intents -> v_k;
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
    IF NOT (v_post_intents ? v_k) THEN
      RAISE EXCEPTION '[intent-namen] ASSERTIE B FOUT: LLM-key % ontbreekt. ROLLBACK.', v_k;
    END IF;
  END LOOP;

  -- ---- ASSERTIE C: geen enkele oude key over. -------------------------------
  FOR v_k IN SELECT k FROM (VALUES
    ('ja_op_uitstel'), ('tegenvoorstel_termijn'), ('gespreid_betalen'),
    ('kan_niet_betalen'), ('al_betaald_claim'), ('boos_of_klacht'),
    ('vraag_om_kopie_factuur'), ('dispute'), ('question'), ('unsubscribe')
  ) AS t(k) LOOP
    IF v_post_intents ? v_k THEN
      RAISE EXCEPTION '[intent-namen] ASSERTIE C FOUT: oude key % bestaat nog. ROLLBACK.', v_k;
    END IF;
  END LOOP;

  -- ---- ASSERTIES D/E/F: pre/post-vergelijking per doel-key. -----------------
  FOR v_target IN SELECT jsonb_object_keys(v_pre_snap) LOOP
    v_pre_mode    := v_pre_snap -> v_target ->> 'mode';
    v_pre_conf    := v_pre_snap -> v_target ->> 'conf';
    v_pre_maxmsg  := v_pre_snap -> v_target ->> 'maxmsg';

    v_post_val    := v_post_intents -> v_target;
    v_post_mode   := v_post_val ->> 'mode';
    v_post_conf   := COALESCE(v_post_val ->> 'confidence_threshold',
                              v_post_val ->> 'min_confidence');
    v_post_maxmsg := v_post_val ->> 'max_messages_per_conv';

    -- D: was PRE 'disabled', moet POST 'disabled' zijn.
    IF v_pre_mode = 'disabled' AND COALESCE(v_post_mode, '') <> 'disabled' THEN
      RAISE EXCEPTION
        '[intent-namen] ASSERTIE D FOUT: % was PRE ''disabled'', POST is ''%''. mode-preserve gefaald. ROLLBACK.',
        v_target, COALESCE(v_post_mode, '(null)');
    END IF;

    -- E: confidence_threshold moet behouden blijven als 'ie in PRE bestond.
    IF v_pre_conf IS NOT NULL AND COALESCE(v_post_conf, '') <> v_pre_conf THEN
      RAISE EXCEPTION
        '[intent-namen] ASSERTIE E FOUT: % PRE confidence=% POST confidence=%. Waarde-preserve gefaald. ROLLBACK.',
        v_target, v_pre_conf, COALESCE(v_post_conf, '(null)');
    END IF;

    -- F: max_messages_per_conv moet behouden blijven als 'ie in PRE bestond.
    IF v_pre_maxmsg IS NOT NULL AND COALESCE(v_post_maxmsg, '') <> v_pre_maxmsg THEN
      RAISE EXCEPTION
        '[intent-namen] ASSERTIE F FOUT: % PRE max_msg=% POST max_msg=%. Waarde-preserve gefaald. ROLLBACK.',
        v_target, v_pre_maxmsg, COALESCE(v_post_maxmsg, '(null)');
    END IF;
  END LOOP;

  RAISE NOTICE '[intent-namen] Alle 6 asserties (A/B/C/D/E/F) geslaagd. Geen autonomous, disabled-modes behouden, confidence + max_msg intact.';
END $$;
