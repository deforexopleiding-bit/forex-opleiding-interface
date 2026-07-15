-- 2026-07-15-joost-fase1-cap-verlagen.sql
-- Joost-integratie fase 1: verlaag max_messages_per_conversation_total van
-- 20 naar 10 voor alle bestaande joost_config-rijen (per-module).
--
-- Achtergrond: originele seed (2026-06-09-joost-e2-autonomy-full.sql r180) zette
-- deze cap op 20. In productie is dat te hoog gebleken -- na 10 uitgaande
-- berichten zonder respons heeft handmatige overname (bellen) meer zin dan
-- doorgaan met Joost. Nieuwe default in code (api/joost-autonomy-evaluate.js
-- r264) is ook 10; deze migratie brengt de bestaande DB-rijen op dezelfde
-- waarde.
--
-- Sub-discriminator max_per_day (3) ONGEWIJZIGD -- dat is een tijdelijke gate,
-- niet een "opgeef"-signaal.
--
-- SQL-string-conventie (les uit #758): geen losse apostrofs in string-literals.
-- jsonb_set met numeric 10 (to_jsonb(10)). Idempotent: alleen updaten waar de
-- huidige waarde 20 is (na re-run doet 'ie niks).

BEGIN;

-- Verlaag de cap in alle joost_config-rijen waar 'ie nog op 20 staat.
UPDATE public.joost_config
SET autonomy_config = jsonb_set(
      autonomy_config,
      '{communication_limits,max_messages_per_conversation_total}',
      to_jsonb(10)
    ),
    updated_at = now()
WHERE (autonomy_config->'communication_limits'->>'max_messages_per_conversation_total')::int = 20;

COMMIT;

-- =============================================================================
-- ROLLBACK (alleen binnen rollback-window)
-- =============================================================================
-- BEGIN;
--   UPDATE public.joost_config
--   SET autonomy_config = jsonb_set(
--         autonomy_config,
--         '{communication_limits,max_messages_per_conversation_total}',
--         to_jsonb(20)
--       ),
--       updated_at = now()
--   WHERE (autonomy_config->'communication_limits'->>'max_messages_per_conversation_total')::int = 10;
-- COMMIT;
