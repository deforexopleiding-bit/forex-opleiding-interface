-- 2026-07-17 — Joost min_termijn_bedrag_eur op EUR 300.
--
-- Beleid Jeffrey (bevestigd, #787):
--   Een termijn onder EUR 300 is geen regeling maar een betaalprobleem
--   dat een mens moet beoordelen. Onder EUR 300 gaat het gesprek niet
--   over "in hoeveel stukken" maar over "kan deze klant nog?". Joost
--   mag daar niet zelfstandig een voorstel voor doen.
--
-- Concrete gevolgen:
--   * factuur EUR 250  → NIET splitsen (open_amount < 2 * 300); Joost
--     biedt geen SPLITSING maar escaleert naar mens.
--   * factuur EUR 1200 → max 4 termijnen (300/300/300/300).
--   * factuur EUR 80 (membership) → niet splitsen; escaleren.
--
-- Handhaving in twee lagen (deze PR):
--   1. api/_lib/joost-suggest-core.js — mandate-alinea in de LLM-prompt
--      krijgt "HARDE ONDERGRENS per termijn: EUR 300" én een range-remark
--      als het openstaand bedrag geen 2 termijnen boven de grens toelaat.
--      Joost weet daarmee vóór het schrijven dat een splitsing niet mag.
--   2. api/arrangements-propose.js — server-side check bij SPLITSING:
--      elke part.amount moet >= min_termijn_bedrag_eur. Zo niet → 400 met
--      violation='MIN_TERMIJN_BEDRAG'. Prompt-instructie is een verzoek;
--      deze check is de garantie.
--
-- Idempotent: overschrijft de bestaande waarde (was 50 — dood veld, geen
-- productie-uitwerking) met 300 via jsonb_set.

BEGIN;

UPDATE public.joost_config
SET autonomy_config = jsonb_set(
      COALESCE(autonomy_config, '{}'::jsonb),
      '{arrangement_mandate,min_termijn_bedrag_eur}',
      to_jsonb(300),
      true
    ),
    updated_at = now()
WHERE module = 'finance';

-- Rapportage voor de log — laat zien wat er nu staat.
DO $$
DECLARE
  v_val jsonb;
BEGIN
  SELECT autonomy_config->'arrangement_mandate'->'min_termijn_bedrag_eur'
    INTO v_val
    FROM public.joost_config
    WHERE module = 'finance';
  RAISE NOTICE '[2026-07-17-joost-min-termijn-bedrag-300] finance.arrangement_mandate.min_termijn_bedrag_eur = %', v_val;
END $$;

COMMIT;
