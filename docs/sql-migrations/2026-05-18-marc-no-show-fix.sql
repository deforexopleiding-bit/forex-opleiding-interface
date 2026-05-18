-- Datum: 2026-05-18
-- Reden: false no-show detect op Marc Van Uytvanghe
-- Oorzaak: lege-email bug in checkLeadJoined() — telefoon-ingebelde Zoom-deelnemers
--          werden behandeld als no-show omdat participantEmail falsy was.
--          Call vond wel daadwerkelijk plaats (~15 min via Zoom).
-- Bugfix: api/follow-up-no-show-detect.js — lege email telt nu als geldige join.
--
-- BELANGRIJK VOOR JEFFREY:
-- Vervang '417d72e8-FULL-UUID-HERE' door het volledige UUID van Marc's appointment.
-- Verificeer eerst: SELECT id, lead_name, status FROM follow_up_appointments WHERE lead_name ILIKE '%uytvanghe%';

BEGIN;

-- Stap 1: Controleer (voer dit eerst uit als SELECT om te verifiëren)
-- SELECT id, lead_name, status, scheduled_at FROM follow_up_appointments
-- WHERE lead_name ILIKE '%uytvanghe%' OR lead_name ILIKE '%marc%';

-- Stap 2: Update status (vul het correcte UUID in)
UPDATE follow_up_appointments
SET
  status     = 'completed',
  updated_at = now()
WHERE id     = '417d72e8-FULL-UUID-HERE'   -- ← vervang dit door het echte UUID
  AND status = 'no_show';

-- Stap 3: Audit-log van handmatige correctie
INSERT INTO follow_up_events_log (
  source,
  event_type,
  payload,
  received_at,
  processed
) VALUES (
  'manual',
  'manual_status_correction',
  '{"from": "no_show", "to": "completed", "lead_name": "Marc Van Uytvanghe", "reason": "false no-show detect: lege-email bug Zoom phone-participant"}'::jsonb,
  now(),
  true
);

COMMIT;

-- ROLLBACK (als correctie ongedaan gemaakt moet worden):
-- BEGIN;
-- UPDATE follow_up_appointments SET status = 'no_show', updated_at = now()
--   WHERE id = '417d72e8-FULL-UUID-HERE' AND status = 'completed';
-- DELETE FROM follow_up_events_log
--   WHERE source = 'manual' AND event_type = 'manual_status_correction'
--     AND payload->>'lead_name' = 'Marc Van Uytvanghe';
-- COMMIT;
