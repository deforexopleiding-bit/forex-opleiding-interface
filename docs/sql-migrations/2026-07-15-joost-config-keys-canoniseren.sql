-- 2026-07-15-joost-config-keys-canoniseren.sql
-- Fix: joost_config.autonomy_config bevatte 3 varianten van dezelfde keys omdat
--   1) de UI (finance-instellingen.js) verkorte namen schreef (max_total, ...)
--   2) de seed-migratie (2026-06-09-joost-e2-autonomy-full.sql) ANDERE verkorte
--      namen gebruikte (max_messages_per_conv_total, min_seconds_between_messages)
--   3) de decision-engine (api/joost-autonomy-evaluate.js) canonical LANGE namen
--      leest (max_messages_per_conversation_total, cooldown_after_outbound_seconds)
--
-- joost-config-upsert.js overschrijft autonomy_config VOLLEDIG bij UPDATE
-- (r182-186 "UI-laag stuurt de full blob"), dus historische UI-saves hebben
-- canonical keys al kunnen weggooien.
--
-- Deze migratie is defensief idempotent:
--   - Alleen COPY-en waar canonical key ontbreekt (foute rijen mag je niet
--     overschrijven als iemand al de canonical waarde gezet heeft).
--   - Daarna foute keys opruimen (jsonb #- operator) zodat geen "dode
--     instellingen" achterblijven die verwarring geven.
--
-- KEY-CONTRACT eindtoestand (na deze migratie):
--   autonomy_config.communication_limits:
--     max_messages_per_conversation_per_day
--     max_messages_per_conversation_total
--     cooldown_after_outbound_seconds    <-- SECONDEN (canonical eenheid)
--     office_hours_only, office_hours_start/end/days/tz
--     no_reply_pause_threshold, no_reply_pause_duration_hours
--   autonomy_config.arrangement_mandate:
--     allowed_types
--     min_total_amount_to_negotiate_eur
--     max_total_amount_to_auto_propose_eur
--     uitstel.{max_dagen_total, ...}
--     splitsing.{max_termijnen_total, ...}
--
-- Voor module='finance' zetten we aan het eind Jeffreys operationele waarden:
--   max_messages_per_conversation_per_day = 10
--   max_messages_per_conversation_total   = 10
--   cooldown_after_outbound_seconds       = 30
-- Andere modules ('events', 'onboarding'): alleen key-hernoeming, waarden blijven.
--
-- SQL-string-conventie (les uit #758): geen losse apostrofs. Alle jsonb-paths
-- als text-arrays. Tokenizer-check vóór oplevering.

BEGIN;

-- =============================================================================
-- 1) communication_limits: canonicalise per-day / total / cooldown
-- =============================================================================
-- Er zijn TWEE oude varianten voor per_day en total (UI vs seed):
--   UI-oud:   max_per_day                       max_total
--   Seed-oud: max_messages_per_conv_per_day     max_messages_per_conv_total
-- Canonical: max_messages_per_conversation_per_day / _total

-- max_per_day (UI-oud) -> canonical
UPDATE public.joost_config
SET autonomy_config = jsonb_set(
      autonomy_config #- '{communication_limits,max_per_day}',
      '{communication_limits,max_messages_per_conversation_per_day}',
      autonomy_config->'communication_limits'->'max_per_day'
    ),
    updated_at = now()
WHERE autonomy_config->'communication_limits' ? 'max_per_day'
  AND NOT (autonomy_config->'communication_limits' ? 'max_messages_per_conversation_per_day');

UPDATE public.joost_config
SET autonomy_config = autonomy_config #- '{communication_limits,max_per_day}',
    updated_at = now()
WHERE autonomy_config->'communication_limits' ? 'max_per_day'
  AND autonomy_config->'communication_limits' ? 'max_messages_per_conversation_per_day';

-- max_messages_per_conv_per_day (seed-oud) -> canonical
UPDATE public.joost_config
SET autonomy_config = jsonb_set(
      autonomy_config #- '{communication_limits,max_messages_per_conv_per_day}',
      '{communication_limits,max_messages_per_conversation_per_day}',
      autonomy_config->'communication_limits'->'max_messages_per_conv_per_day'
    ),
    updated_at = now()
WHERE autonomy_config->'communication_limits' ? 'max_messages_per_conv_per_day'
  AND NOT (autonomy_config->'communication_limits' ? 'max_messages_per_conversation_per_day');

UPDATE public.joost_config
SET autonomy_config = autonomy_config #- '{communication_limits,max_messages_per_conv_per_day}',
    updated_at = now()
WHERE autonomy_config->'communication_limits' ? 'max_messages_per_conv_per_day'
  AND autonomy_config->'communication_limits' ? 'max_messages_per_conversation_per_day';

-- max_total (UI-oud) -> canonical
UPDATE public.joost_config
SET autonomy_config = jsonb_set(
      autonomy_config #- '{communication_limits,max_total}',
      '{communication_limits,max_messages_per_conversation_total}',
      autonomy_config->'communication_limits'->'max_total'
    ),
    updated_at = now()
WHERE autonomy_config->'communication_limits' ? 'max_total'
  AND NOT (autonomy_config->'communication_limits' ? 'max_messages_per_conversation_total');

UPDATE public.joost_config
SET autonomy_config = autonomy_config #- '{communication_limits,max_total}',
    updated_at = now()
WHERE autonomy_config->'communication_limits' ? 'max_total'
  AND autonomy_config->'communication_limits' ? 'max_messages_per_conversation_total';

-- max_messages_per_conv_total (seed-oud) -> canonical
UPDATE public.joost_config
SET autonomy_config = jsonb_set(
      autonomy_config #- '{communication_limits,max_messages_per_conv_total}',
      '{communication_limits,max_messages_per_conversation_total}',
      autonomy_config->'communication_limits'->'max_messages_per_conv_total'
    ),
    updated_at = now()
WHERE autonomy_config->'communication_limits' ? 'max_messages_per_conv_total'
  AND NOT (autonomy_config->'communication_limits' ? 'max_messages_per_conversation_total');

UPDATE public.joost_config
SET autonomy_config = autonomy_config #- '{communication_limits,max_messages_per_conv_total}',
    updated_at = now()
WHERE autonomy_config->'communication_limits' ? 'max_messages_per_conv_total'
  AND autonomy_config->'communication_limits' ? 'max_messages_per_conversation_total';

-- ── cooldown: 3 oude varianten -> cooldown_after_outbound_seconds ──
-- min_seconds_between (UI-oud, seconden) -> _seconds
UPDATE public.joost_config
SET autonomy_config = jsonb_set(
      autonomy_config #- '{communication_limits,min_seconds_between}',
      '{communication_limits,cooldown_after_outbound_seconds}',
      autonomy_config->'communication_limits'->'min_seconds_between'
    ),
    updated_at = now()
WHERE autonomy_config->'communication_limits' ? 'min_seconds_between'
  AND NOT (autonomy_config->'communication_limits' ? 'cooldown_after_outbound_seconds');

UPDATE public.joost_config
SET autonomy_config = autonomy_config #- '{communication_limits,min_seconds_between}',
    updated_at = now()
WHERE autonomy_config->'communication_limits' ? 'min_seconds_between'
  AND autonomy_config->'communication_limits' ? 'cooldown_after_outbound_seconds';

-- min_seconds_between_messages (seed-oud, seconden) -> _seconds
UPDATE public.joost_config
SET autonomy_config = jsonb_set(
      autonomy_config #- '{communication_limits,min_seconds_between_messages}',
      '{communication_limits,cooldown_after_outbound_seconds}',
      autonomy_config->'communication_limits'->'min_seconds_between_messages'
    ),
    updated_at = now()
WHERE autonomy_config->'communication_limits' ? 'min_seconds_between_messages'
  AND NOT (autonomy_config->'communication_limits' ? 'cooldown_after_outbound_seconds');

UPDATE public.joost_config
SET autonomy_config = autonomy_config #- '{communication_limits,min_seconds_between_messages}',
    updated_at = now()
WHERE autonomy_config->'communication_limits' ? 'min_seconds_between_messages'
  AND autonomy_config->'communication_limits' ? 'cooldown_after_outbound_seconds';

-- cooldown_after_outbound_minutes (interim, minutes) -> _seconds (*60)
UPDATE public.joost_config
SET autonomy_config = jsonb_set(
      autonomy_config #- '{communication_limits,cooldown_after_outbound_minutes}',
      '{communication_limits,cooldown_after_outbound_seconds}',
      to_jsonb(((autonomy_config->'communication_limits'->>'cooldown_after_outbound_minutes')::int) * 60)
    ),
    updated_at = now()
WHERE autonomy_config->'communication_limits' ? 'cooldown_after_outbound_minutes'
  AND NOT (autonomy_config->'communication_limits' ? 'cooldown_after_outbound_seconds')
  AND (autonomy_config->'communication_limits'->>'cooldown_after_outbound_minutes') ~ '^[0-9]+$';

UPDATE public.joost_config
SET autonomy_config = autonomy_config #- '{communication_limits,cooldown_after_outbound_minutes}',
    updated_at = now()
WHERE autonomy_config->'communication_limits' ? 'cooldown_after_outbound_minutes'
  AND autonomy_config->'communication_limits' ? 'cooldown_after_outbound_seconds';

-- office_start / office_end (UI-oud) -> office_hours_start / _end
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
-- 2) arrangement_mandate top-level: 2 foute UI-keys -> canonical
-- =============================================================================
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
-- 3) arrangement_mandate genest: 2 foute top-level keys -> splitsing.*/uitstel.*
-- =============================================================================
-- max_termijnen -> splitsing.max_termijnen_total (met behoud van bestaande sub-keys)
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

-- max_uitstel_dagen -> uitstel.max_dagen_total
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

-- =============================================================================
-- 4) Finance operationele waarden zetten (Jeffrey's target: 10 / 10 / 30s)
-- =============================================================================
-- Non-destructief voor office_hours_* (blijven zoals ingesteld: 08:00-20:00).
-- Overschrijft ALTIJD (idempotent voor deze specifieke waarden — bij re-run
-- blijven 10/10/30 gewoon staan; als iemand ze via UI aanpast naar iets
-- anders wordt dat bij re-run WEL teruggezet — die is idempotent per
-- migratie-draai, niet t.o.v. latere UI-wijzigingen).
UPDATE public.joost_config
SET autonomy_config = jsonb_set(
      jsonb_set(
        jsonb_set(
          autonomy_config,
          '{communication_limits,max_messages_per_conversation_per_day}',
          to_jsonb(10)
        ),
        '{communication_limits,max_messages_per_conversation_total}',
        to_jsonb(10)
      ),
      '{communication_limits,cooldown_after_outbound_seconds}',
      to_jsonb(30)
    ),
    updated_at = now()
WHERE module = 'finance';

COMMIT;

-- =============================================================================
-- VERIFICATIE (handmatig na draaien)
-- =============================================================================
-- SELECT module,
--        autonomy_config->'communication_limits' AS comm_limits,
--        autonomy_config->'arrangement_mandate'  AS mandate
-- FROM public.joost_config
-- ORDER BY module;
--
-- Verwacht voor 'finance':
--   comm_limits keys = {max_messages_per_conversation_per_day, _total,
--                       cooldown_after_outbound_seconds, office_hours_only,
--                       office_hours_start, office_hours_end, office_hours_tz,
--                       office_hours_days, no_reply_pause_threshold,
--                       no_reply_pause_duration_hours}
--   comm_limits waarden: per_day=10, total=10, cooldown_seconds=30
--   mandate keys: allowed_types, min_total_amount_to_negotiate_eur,
--                 max_total_amount_to_auto_propose_eur, uitstel.*, splitsing.*,
--                 abonnement_pauze, abonnement_stop, kwijtschelding
--   geen dode keys uit UI-oud of seed-oud.
--
-- Voor 'events' en 'onboarding': alleen key-hernoemingen, geen waarde-wijzigingen.
--
-- =============================================================================
-- ROLLBACK (alleen binnen rollback-window)
-- =============================================================================
-- Deze migratie is destructief voor foute keys (jsonb #-). Rollback vereist
-- reconstructie uit de canonical waarden. Voor finance-caps: pas een handmatige
-- UPDATE toe met de oude waarden als je die weet. Verifieer eerst met SELECT
-- voordat je een rollback overweegt.
