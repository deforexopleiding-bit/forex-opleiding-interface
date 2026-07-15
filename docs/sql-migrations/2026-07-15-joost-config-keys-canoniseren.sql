-- 2026-07-15-joost-config-keys-canoniseren.sql
-- Fix: joost_config.autonomy_config bevatte foute keys omdat de UI
-- (modules/shared/finance-instellingen.js) verkorte namen schreef die de
-- decision-engine (api/joost-autonomy-evaluate.js) niet las.
--
-- Achtergrond: joost-config-upsert.js overschrijft autonomy_config VOLLEDIG
-- bij UPDATE (read-modify-write vanuit UI). Als Jeffrey ooit een save deed
-- via Instellingen->Joost, staan de canonical seed-keys niet meer in de DB
-- en valt de engine terug op code-defaults.
--
-- Deze migratie is DEFENSIEF idempotent:
--   - Alleen fixen waar de foute key aanwezig is EN de canonical key ONTBREEKT
--     (of NULL is). Als de canonical key al waarde heeft, blijft die staan
--     (dan is-ie leidend en heeft de UI 'em al vervangen door onze fix).
--   - Foute keys worden na copy opgeruimd (jsonb `#-` operator).
--   - Idempotent: na re-run doet 't niets (WHERE-guards vinden geen rijen meer).
--
-- SQL-string-conventie (les uit #758): geen losse apostrofs in string-literals.
-- Alle jsonb-paths als text-arrays.

BEGIN;

-- =============================================================================
-- 1) communication_limits: 6 foute keys naar canonical
-- =============================================================================
-- max_per_day -> max_messages_per_conversation_per_day
UPDATE public.joost_config
SET autonomy_config = jsonb_set(
      autonomy_config #- '{communication_limits,max_per_day}',
      '{communication_limits,max_messages_per_conversation_per_day}',
      autonomy_config->'communication_limits'->'max_per_day'
    ),
    updated_at = now()
WHERE autonomy_config->'communication_limits' ? 'max_per_day'
  AND NOT (autonomy_config->'communication_limits' ? 'max_messages_per_conversation_per_day');

-- max_total -> max_messages_per_conversation_total
UPDATE public.joost_config
SET autonomy_config = jsonb_set(
      autonomy_config #- '{communication_limits,max_total}',
      '{communication_limits,max_messages_per_conversation_total}',
      autonomy_config->'communication_limits'->'max_total'
    ),
    updated_at = now()
WHERE autonomy_config->'communication_limits' ? 'max_total'
  AND NOT (autonomy_config->'communication_limits' ? 'max_messages_per_conversation_total');

-- min_seconds_between -> cooldown_after_outbound_minutes (units-conversie: seconds/60 -> minutes, CEIL)
UPDATE public.joost_config
SET autonomy_config = jsonb_set(
      autonomy_config #- '{communication_limits,min_seconds_between}',
      '{communication_limits,cooldown_after_outbound_minutes}',
      to_jsonb(GREATEST(1, CEIL((autonomy_config->'communication_limits'->>'min_seconds_between')::numeric / 60.0)::int))
    ),
    updated_at = now()
WHERE autonomy_config->'communication_limits' ? 'min_seconds_between'
  AND NOT (autonomy_config->'communication_limits' ? 'cooldown_after_outbound_minutes')
  AND (autonomy_config->'communication_limits'->>'min_seconds_between') ~ '^[0-9]+(\.[0-9]+)?$';

-- Als min_seconds_between wel bestaat maar cooldown_after_outbound_minutes OOK -> alleen foute key opruimen.
UPDATE public.joost_config
SET autonomy_config = autonomy_config #- '{communication_limits,min_seconds_between}',
    updated_at = now()
WHERE autonomy_config->'communication_limits' ? 'min_seconds_between'
  AND autonomy_config->'communication_limits' ? 'cooldown_after_outbound_minutes';

-- Idem voor max_per_day / max_total waar canonical al bestond: foute key opruimen.
UPDATE public.joost_config
SET autonomy_config = autonomy_config #- '{communication_limits,max_per_day}',
    updated_at = now()
WHERE autonomy_config->'communication_limits' ? 'max_per_day'
  AND autonomy_config->'communication_limits' ? 'max_messages_per_conversation_per_day';

UPDATE public.joost_config
SET autonomy_config = autonomy_config #- '{communication_limits,max_total}',
    updated_at = now()
WHERE autonomy_config->'communication_limits' ? 'max_total'
  AND autonomy_config->'communication_limits' ? 'max_messages_per_conversation_total';

-- office_start -> office_hours_start
UPDATE public.joost_config
SET autonomy_config = jsonb_set(
      autonomy_config #- '{communication_limits,office_start}',
      '{communication_limits,office_hours_start}',
      autonomy_config->'communication_limits'->'office_start'
    ),
    updated_at = now()
WHERE autonomy_config->'communication_limits' ? 'office_start'
  AND NOT (autonomy_config->'communication_limits' ? 'office_hours_start');

UPDATE public.joost_config
SET autonomy_config = autonomy_config #- '{communication_limits,office_start}',
    updated_at = now()
WHERE autonomy_config->'communication_limits' ? 'office_start'
  AND autonomy_config->'communication_limits' ? 'office_hours_start';

-- office_end -> office_hours_end
UPDATE public.joost_config
SET autonomy_config = jsonb_set(
      autonomy_config #- '{communication_limits,office_end}',
      '{communication_limits,office_hours_end}',
      autonomy_config->'communication_limits'->'office_end'
    ),
    updated_at = now()
WHERE autonomy_config->'communication_limits' ? 'office_end'
  AND NOT (autonomy_config->'communication_limits' ? 'office_hours_end');

UPDATE public.joost_config
SET autonomy_config = autonomy_config #- '{communication_limits,office_end}',
    updated_at = now()
WHERE autonomy_config->'communication_limits' ? 'office_end'
  AND autonomy_config->'communication_limits' ? 'office_hours_end';

-- =============================================================================
-- 2) arrangement_mandate top-level: 2 foute keys naar canonical
-- =============================================================================
-- min_to_negotiate -> min_total_amount_to_negotiate_eur
UPDATE public.joost_config
SET autonomy_config = jsonb_set(
      autonomy_config #- '{arrangement_mandate,min_to_negotiate}',
      '{arrangement_mandate,min_total_amount_to_negotiate_eur}',
      autonomy_config->'arrangement_mandate'->'min_to_negotiate'
    ),
    updated_at = now()
WHERE autonomy_config->'arrangement_mandate' ? 'min_to_negotiate'
  AND NOT (autonomy_config->'arrangement_mandate' ? 'min_total_amount_to_negotiate_eur');

UPDATE public.joost_config
SET autonomy_config = autonomy_config #- '{arrangement_mandate,min_to_negotiate}',
    updated_at = now()
WHERE autonomy_config->'arrangement_mandate' ? 'min_to_negotiate'
  AND autonomy_config->'arrangement_mandate' ? 'min_total_amount_to_negotiate_eur';

-- max_auto_propose -> max_total_amount_to_auto_propose_eur
UPDATE public.joost_config
SET autonomy_config = jsonb_set(
      autonomy_config #- '{arrangement_mandate,max_auto_propose}',
      '{arrangement_mandate,max_total_amount_to_auto_propose_eur}',
      autonomy_config->'arrangement_mandate'->'max_auto_propose'
    ),
    updated_at = now()
WHERE autonomy_config->'arrangement_mandate' ? 'max_auto_propose'
  AND NOT (autonomy_config->'arrangement_mandate' ? 'max_total_amount_to_auto_propose_eur');

UPDATE public.joost_config
SET autonomy_config = autonomy_config #- '{arrangement_mandate,max_auto_propose}',
    updated_at = now()
WHERE autonomy_config->'arrangement_mandate' ? 'max_auto_propose'
  AND autonomy_config->'arrangement_mandate' ? 'max_total_amount_to_auto_propose_eur';

-- =============================================================================
-- 3) arrangement_mandate genest: 2 foute top-level keys naar splitsing.*/uitstel.*
-- =============================================================================
-- max_termijnen -> splitsing.max_termijnen_total (met behoud van bestaande splitsing sub-keys)
UPDATE public.joost_config
SET autonomy_config = jsonb_set(
      autonomy_config #- '{arrangement_mandate,max_termijnen}',
      '{arrangement_mandate,splitsing}',
      COALESCE(autonomy_config->'arrangement_mandate'->'splitsing', '{}'::jsonb)
        || jsonb_build_object('max_termijnen_total', (autonomy_config->'arrangement_mandate'->>'max_termijnen')::int)
    ),
    updated_at = now()
WHERE autonomy_config->'arrangement_mandate' ? 'max_termijnen'
  AND (autonomy_config->'arrangement_mandate'->>'max_termijnen') ~ '^[0-9]+$'
  AND NOT (COALESCE(autonomy_config->'arrangement_mandate'->'splitsing', '{}'::jsonb) ? 'max_termijnen_total');

UPDATE public.joost_config
SET autonomy_config = autonomy_config #- '{arrangement_mandate,max_termijnen}',
    updated_at = now()
WHERE autonomy_config->'arrangement_mandate' ? 'max_termijnen'
  AND COALESCE(autonomy_config->'arrangement_mandate'->'splitsing', '{}'::jsonb) ? 'max_termijnen_total';

-- max_uitstel_dagen -> uitstel.max_dagen_total (met behoud van bestaande uitstel sub-keys)
UPDATE public.joost_config
SET autonomy_config = jsonb_set(
      autonomy_config #- '{arrangement_mandate,max_uitstel_dagen}',
      '{arrangement_mandate,uitstel}',
      COALESCE(autonomy_config->'arrangement_mandate'->'uitstel', '{}'::jsonb)
        || jsonb_build_object('max_dagen_total', (autonomy_config->'arrangement_mandate'->>'max_uitstel_dagen')::int)
    ),
    updated_at = now()
WHERE autonomy_config->'arrangement_mandate' ? 'max_uitstel_dagen'
  AND (autonomy_config->'arrangement_mandate'->>'max_uitstel_dagen') ~ '^[0-9]+$'
  AND NOT (COALESCE(autonomy_config->'arrangement_mandate'->'uitstel', '{}'::jsonb) ? 'max_dagen_total');

UPDATE public.joost_config
SET autonomy_config = autonomy_config #- '{arrangement_mandate,max_uitstel_dagen}',
    updated_at = now()
WHERE autonomy_config->'arrangement_mandate' ? 'max_uitstel_dagen'
  AND COALESCE(autonomy_config->'arrangement_mandate'->'uitstel', '{}'::jsonb) ? 'max_dagen_total';

COMMIT;

-- =============================================================================
-- VERIFICATIE (handmatig na draaien)
-- =============================================================================
-- SELECT module,
--        autonomy_config->'communication_limits' AS comm_limits,
--        autonomy_config->'arrangement_mandate'  AS mandate
-- FROM public.joost_config
-- WHERE module = 'finance';
--
-- Verwacht: geen keys `max_per_day`, `max_total`, `min_seconds_between`,
-- `office_start`, `office_end` in comm_limits;
-- geen keys `min_to_negotiate`, `max_auto_propose`, `max_termijnen`,
-- `max_uitstel_dagen` in mandate top-level.
-- Wel: max_messages_per_conversation_per_day, max_messages_per_conversation_total,
-- cooldown_after_outbound_minutes, office_hours_start, office_hours_end,
-- min_total_amount_to_negotiate_eur, max_total_amount_to_auto_propose_eur,
-- uitstel.max_dagen_total, splitsing.max_termijnen_total.

-- =============================================================================
-- ROLLBACK (alleen binnen rollback-window)
-- =============================================================================
-- Deze migratie is destructief voor de foute keys (jsonb #-). Rollback zou
-- vereisen dat je de foute keys herstelt uit de canonical waarden -- doe dat
-- alleen als je het zeker weet. Voorbeeld voor communication_limits:
-- BEGIN;
--   UPDATE public.joost_config
--   SET autonomy_config = jsonb_set(
--         autonomy_config,
--         '{communication_limits,max_per_day}',
--         autonomy_config->'communication_limits'->'max_messages_per_conversation_per_day'
--       )
--   WHERE autonomy_config->'communication_limits' ? 'max_messages_per_conversation_per_day';
--   -- idem voor de andere keys.
-- COMMIT;
