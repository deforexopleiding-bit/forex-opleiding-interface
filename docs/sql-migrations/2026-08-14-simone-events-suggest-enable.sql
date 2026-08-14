-- 2026-08-14-simone-events-suggest-enable.sql
--
-- Zet Simone's suggestie-mode AAN voor de event-inbox.
-- LAAT autonoom versturen UIT (events_reactive_autonomy blijft false).
--
-- Effect:
--   - joost_config WHERE module='events' krijgt is_enabled=true
--   - feature_flags.reactive_suggest_enabled = true
--   - feature_flags.events_reactive_autonomy blijft (of wordt gezet op) false
--
-- Simone genereert vanaf nu automatisch VOORGESTELDE antwoorden op inkomende
-- WhatsApp-berichten (schrijft naar joost_suggestions met status='PROPOSED').
-- Er gaat NIETS automatisch de deur uit — Jeffrey verstuurt zelf via de inbox
-- composer met de "Overnemen"-knop.
--
-- Idempotent: kan meerdere keren gedraaid worden, wijzigt alleen als state
-- afwijkt. Volledige config wordt via jsonb_set gemuteerd (zelfde patroon als
-- alle andere agent-config writes — geen null-columns overschrijven).

DO $$
DECLARE
  cur_row       joost_config%ROWTYPE;
  cur_flags     jsonb;
  new_flags     jsonb;
BEGIN
  -- Rij ophalen (module='events' — één rij per module afgedwongen door unique index)
  SELECT * INTO cur_row FROM joost_config WHERE module = 'events' LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Geen joost_config rij voor module=events gevonden. Migratie eerder in de rollout moet die aanmaken.';
  END IF;

  cur_flags := COALESCE(cur_row.feature_flags, '{}'::jsonb);

  -- Merge: reactive_suggest_enabled=true, events_reactive_autonomy=false
  -- (expliciet false zetten, niet default UIT afhankelijk maken van absence).
  new_flags := cur_flags
             || jsonb_build_object(
                  'reactive_suggest_enabled', true,
                  'events_reactive_autonomy', false
                );

  UPDATE joost_config
     SET is_enabled    = true,
         feature_flags = new_flags,
         updated_at    = now()
   WHERE module = 'events';

  RAISE NOTICE 'Simone events-config bijgewerkt: is_enabled=true, reactive_suggest_enabled=true, events_reactive_autonomy=false';
END $$;

-- Verificatie (los statement zodat je zichtbaar hebt of het klopt)
SELECT
  module,
  is_enabled,
  feature_flags->'reactive_suggest_enabled' AS reactive_suggest_enabled,
  feature_flags->'events_reactive_autonomy' AS events_reactive_autonomy,
  updated_at
FROM joost_config
WHERE module = 'events';
