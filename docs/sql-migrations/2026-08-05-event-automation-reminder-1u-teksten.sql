-- 2026-08-05 — Reminder "laatste uren" op T-1u — teksten synchroniseren
--
-- Context: event_automations rij 8c7c05b8-9470-464e-bcf0-721d1c712e42
-- ("Reminder laatste uren") stond op hours_before=3 met inconsistente teksten
-- (onderwerp "Over een uur", body "Nog een paar uurtjes", WhatsApp
-- reminder_2u_v3). hours_before is inmiddels op 1 gezet.
--
-- Deze migratie doet 2 data-updates in event_automations.steps (jsonb):
--   1. send_email.config.body — vervang "Nog een paar uurtjes en dan zien
--      we je" → "Over een uur zien we je"
--   2. send_whatsapp.config.template_name — vervang "reminder_2u_v3" →
--      "reminder_2u_correct" (bestaande APPROVED template die "over een
--      paar uur" zegt, past bij 1 uur)
--
-- IDEMPOTENT: replace() en jsonb_set laten stappen die niet matchen ongemoeid.
-- Herhaalde runs doen niets. Andere automations blijven onaangeraakt
-- (WHERE-clause op id).
--
-- VEILIG (data-only): geen schema-wijziging, geen constraint-verandering.
-- Rollback = eerste update ongedaan maken via omgekeerde replace(), of
-- gewoon herstellen via de events-automations UI met de oude teksten.

-- ── STAP 0 — Preflight: bekijk huidige waardes vóór je iets muteert ────────
-- Draai deze SELECT eerst en verifieer:
--   * body bevat de te vervangen zin letterlijk
--   * template_name is inderdaad 'reminder_2u_v3'
--   * hours_before is 1

-- SELECT
--   id, name, trigger_config,
--   jsonb_agg(
--     jsonb_build_object(
--       'idx', idx - 1,
--       'type', step->>'type',
--       'subject', step->'config'->>'subject',
--       'body', step->'config'->>'body',
--       'template_name', step->'config'->>'template_name'
--     )
--   ) AS steps_preview
-- FROM event_automations,
--   LATERAL jsonb_array_elements(steps) WITH ORDINALITY AS t(step, idx)
-- WHERE id = '8c7c05b8-9470-464e-bcf0-721d1c712e42'
-- GROUP BY id, name, trigger_config;

-- ── STAP 1 — Check of andere automations óók reminder_2u_v3 gebruiken ──────
-- Voer deze uit zodat je een compleet plaatje hebt van waar de template-naam
-- nog voorkomt. Als je resultaten hier krijgt buiten 8c7c05b8-..., overweeg
-- of die óók naar reminder_2u_correct moeten (buiten scope van deze migratie).

-- SELECT id, name, trigger_type, trigger_config,
--        jsonb_array_length(steps) AS n_steps
-- FROM event_automations
-- WHERE steps::text ILIKE '%reminder_2u_v3%';

-- ── STAP 2 — De feitelijke update (idempotent) ─────────────────────────────

UPDATE event_automations
SET steps = (
  SELECT jsonb_agg(
    CASE
      -- send_email: vervang de "Nog een paar uurtjes"-zin in de body.
      -- replace() is no-op als de substring niet voorkomt, dus veilig bij
      -- herhaalde runs.
      WHEN step->>'type' = 'send_email'
        AND step->'config'->>'body' IS NOT NULL
        THEN jsonb_set(
          step,
          '{config,body}',
          to_jsonb(replace(
            step->'config'->>'body',
            'Nog een paar uurtjes en dan zien we je',
            'Over een uur zien we je'
          ))
        )
      -- send_whatsapp: zet template_name om NAAR reminder_2u_correct wanneer
      -- 'ie nu reminder_2u_v3 is. Andere template_names blijven ongemoeid.
      WHEN step->>'type' = 'send_whatsapp'
        AND step->'config'->>'template_name' = 'reminder_2u_v3'
        THEN jsonb_set(
          step,
          '{config,template_name}',
          '"reminder_2u_correct"'::jsonb
        )
      ELSE step
    END
    ORDER BY idx
  )
  FROM jsonb_array_elements(steps) WITH ORDINALITY AS t(step, idx)
),
updated_at = now()
WHERE id = '8c7c05b8-9470-464e-bcf0-721d1c712e42';

-- ── STAP 3 — Verify: bekijk resultaat ───────────────────────────────────────

-- SELECT
--   id, name, updated_at,
--   jsonb_agg(
--     jsonb_build_object(
--       'idx', idx - 1,
--       'type', step->>'type',
--       'subject', step->'config'->>'subject',
--       'body', step->'config'->>'body',
--       'template_name', step->'config'->>'template_name'
--     )
--   ) AS steps_after
-- FROM event_automations,
--   LATERAL jsonb_array_elements(steps) WITH ORDINALITY AS t(step, idx)
-- WHERE id = '8c7c05b8-9470-464e-bcf0-721d1c712e42'
-- GROUP BY id, name, updated_at;
