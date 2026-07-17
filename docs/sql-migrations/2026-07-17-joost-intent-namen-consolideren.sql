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
--   effectief werden GENEGEERD door de evaluator (die de seed-set leest).
--
-- WAT DEZE MIGRATIE DOET
--   1. Snapshot van de PRE-state.
--   2. Renamet oude keys naar LLM-set, met "UI-waarde wint bij conflict":
--        UI arrangement_request  || seed tegenvoorstel_termijn  -> arrangement_request
--        UI payment_promise      || seed ja_op_uitstel           -> payment_promise
--        seed al_betaald_claim                                    -> verify_payment
--        UI question             || seed vraag_om_kopie_factuur   -> general_question
--        UI dispute              || seed boos_of_klacht           -> escalation_needed
--        UI other                                                 -> other (identity)
--      Waarden (confidence, max_messages_per_conv) worden meegenomen; extra
--      seed-velden (bv. max_termijn_dagen) blijven behouden.
--
--   3. HARDE MODE-REGEL: elke nieuwe intent-key wordt geforceerd op mode='draft'.
--      Als er ergens (UI of seed) mode='autonomous' stond, wordt dat teruggezet.
--      Dit is een expliciete keuze — Jeffrey heeft bevestigd "alles staat nu op
--      draft, dat moet zo blijven". De VERIFY-FIRST query waarschuwt vooraf
--      als er ergens autonomous stond.
--
--   4. Dropt de dode keys:
--        - unsubscribe             (UI-key zonder LLM-tegenhanger)
--        - gespreid_betalen        (seed-key; splitsing zit al in arrangement_mandate.splitsing)
--        - kan_niet_betalen        (seed-key zonder LLM-tegenhanger — escalation_needed dekt dit)
--        - dispute / question      (UI-oud, na hun rename)
--        - ja_op_uitstel / tegenvoorstel_termijn / al_betaald_claim /
--          boos_of_klacht / vraag_om_kopie_factuur (seed-oud, na hun rename)
--
--   5. Post-state RAISE NOTICE + assertion: geen intent-key mag na afloop
--      op mode='autonomous' staan. Als de assertion faalt: ROLLBACK.
--
-- IDEMPOTENT: elke rename kijkt eerst of de doel-key al bestaat en overschrijft
--   die dan niet — 2e run verandert niets.
--
-- ROLLBACK-STRATEGIE: alles binnen 1 transactie. Bij een assertion-fout doet
--   PostgreSQL automatisch ROLLBACK. Voor debuggen kun je de RAISE NOTICE-
--   regels lezen in de query-output.

BEGIN;

-- 1. PRE-STATE RAPPORTAGE ----------------------------------------------------
DO $$
DECLARE
  v_intents  jsonb;
  v_k        text;
  v_val      jsonb;
BEGIN
  SELECT autonomy_config -> 'intents'
    INTO v_intents
    FROM public.joost_config
    WHERE module = 'finance';

  IF v_intents IS NULL THEN
    RAISE NOTICE '[intent-namen] PRE-state: intents-object bestaat niet voor finance. Niets te migreren.';
    RETURN;
  END IF;

  RAISE NOTICE '[intent-namen] PRE-state (voor rename):';
  FOR v_k IN SELECT jsonb_object_keys(v_intents) LOOP
    v_val := v_intents -> v_k;
    RAISE NOTICE '  intent=%  mode=%  confidence=%  max_msg=%',
      v_k,
      COALESCE(v_val->>'mode', '(null)'),
      COALESCE(v_val->>'confidence_threshold', v_val->>'min_confidence', '(null)'),
      COALESCE(v_val->>'max_messages_per_conv', '(null)');
  END LOOP;
END $$;

-- 2. RENAME + MERGE ---------------------------------------------------------
-- Helper-CTE: bouw nieuwe intents-blob op basis van bestaande.
UPDATE public.joost_config AS jc
   SET autonomy_config = jsonb_set(
     COALESCE(autonomy_config, '{}'::jsonb),
     '{intents}',
     (
       WITH old AS (
         SELECT autonomy_config -> 'intents' AS intents FROM public.joost_config WHERE module = 'finance'
       ),
       -- Per doel-key: kies bron-waarde. Prioriteit: (a) nieuwe key als al bestaat
       -- (idempotency); (b) UI-oude key; (c) seed-oude key. Force mode='draft'
       -- op elke doel-key.
       merged AS (
         SELECT jsonb_strip_nulls(
           jsonb_build_object(
             -- payment_promise: UI 'payment_promise' | seed 'ja_op_uitstel'
             'payment_promise', jsonb_set(
               COALESCE(
                 old.intents -> 'payment_promise',
                 old.intents -> 'ja_op_uitstel',
                 '{}'::jsonb
               ),
               '{mode}',
               '"draft"'::jsonb,
               true
             ),
             -- arrangement_request: UI 'arrangement_request' | seed 'tegenvoorstel_termijn'
             'arrangement_request', jsonb_set(
               COALESCE(
                 old.intents -> 'arrangement_request',
                 old.intents -> 'tegenvoorstel_termijn',
                 '{}'::jsonb
               ),
               '{mode}',
               '"draft"'::jsonb,
               true
             ),
             -- verify_payment: alleen seed 'al_betaald_claim' (geen UI-key)
             'verify_payment', jsonb_set(
               COALESCE(old.intents -> 'al_betaald_claim', '{}'::jsonb),
               '{mode}',
               '"draft"'::jsonb,
               true
             ),
             -- general_question: UI 'question' | seed 'vraag_om_kopie_factuur'
             'general_question', jsonb_set(
               COALESCE(
                 old.intents -> 'question',
                 old.intents -> 'vraag_om_kopie_factuur',
                 '{}'::jsonb
               ),
               '{mode}',
               '"draft"'::jsonb,
               true
             ),
             -- escalation_needed: UI 'dispute' | seed 'boos_of_klacht'
             'escalation_needed', jsonb_set(
               COALESCE(
                 old.intents -> 'dispute',
                 old.intents -> 'boos_of_klacht',
                 '{}'::jsonb
               ),
               '{mode}',
               '"draft"'::jsonb,
               true
             ),
             -- other: UI 'other' (identity)
             'other', jsonb_set(
               COALESCE(old.intents -> 'other', '{}'::jsonb),
               '{mode}',
               '"draft"'::jsonb,
               true
             )
           )
         ) AS new_intents
         FROM old
       )
       SELECT new_intents FROM merged
     ),
     true
   ),
   updated_at = now()
 WHERE module = 'finance';

-- 3. POST-STATE RAPPORTAGE + ASSERTIE ---------------------------------------
DO $$
DECLARE
  v_intents          jsonb;
  v_k                text;
  v_val              jsonb;
  v_autonomous_count int := 0;
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

  -- ASSERTIE: geen enkele intent mag op autonomous staan.
  IF v_autonomous_count > 0 THEN
    RAISE EXCEPTION
      '[intent-namen] ASSERTIE-FOUT: % intent(s) staat/staan nu op mode=autonomous. Rename mag dat NIET introduceren. ROLLBACK.',
      v_autonomous_count;
  END IF;

  -- ASSERTIE: alle LLM-keys moeten aanwezig zijn.
  FOR v_k IN
    SELECT k FROM (VALUES
      ('payment_promise'), ('verify_payment'), ('arrangement_request'),
      ('general_question'), ('escalation_needed'), ('other')
    ) AS t(k)
  LOOP
    IF NOT (v_intents ? v_k) THEN
      RAISE EXCEPTION '[intent-namen] ASSERTIE-FOUT: LLM-key % ontbreekt in POST-state. ROLLBACK.', v_k;
    END IF;
  END LOOP;

  -- ASSERTIE: geen enkele oude key mag nog bestaan.
  FOR v_k IN
    SELECT k FROM (VALUES
      ('ja_op_uitstel'), ('tegenvoorstel_termijn'), ('gespreid_betalen'),
      ('kan_niet_betalen'), ('al_betaald_claim'), ('boos_of_klacht'),
      ('vraag_om_kopie_factuur'), ('dispute'), ('question'), ('unsubscribe')
    ) AS t(k)
  LOOP
    IF v_intents ? v_k THEN
      RAISE EXCEPTION '[intent-namen] ASSERTIE-FOUT: oude key % bestaat nog in POST-state. ROLLBACK.', v_k;
    END IF;
  END LOOP;

  RAISE NOTICE '[intent-namen] Alle asserties geslaagd. % intent(s) actief, geen op autonomous.',
    jsonb_object_keys_count(v_intents);
EXCEPTION
  WHEN undefined_function THEN
    -- jsonb_object_keys_count bestaat niet standaard; alleen NOTICE-gebruik.
    RAISE NOTICE '[intent-namen] Alle asserties geslaagd. Geen intent op autonomous.';
END $$;

COMMIT;
