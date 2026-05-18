-- Migratie: uitbreiden voicememo_status enum met 'no_whatsapp'
-- Datum: 2026-05-18
-- Doel: Dave kan markeren dat een lead geen WhatsApp heeft

ALTER TABLE follow_up_appointments
  DROP CONSTRAINT IF EXISTS follow_up_appointments_voicememo_status_check;

ALTER TABLE follow_up_appointments
  ADD CONSTRAINT follow_up_appointments_voicememo_status_check
  CHECK (voicememo_status IN ('pending', 'sent', 'skipped', 'no_whatsapp'));

-- ROLLBACK:
-- ALTER TABLE follow_up_appointments DROP CONSTRAINT follow_up_appointments_voicememo_status_check;
-- UPDATE follow_up_appointments SET voicememo_status = 'pending' WHERE voicememo_status = 'no_whatsapp';
-- ALTER TABLE follow_up_appointments ADD CONSTRAINT follow_up_appointments_voicememo_status_check
--   CHECK (voicememo_status IN ('pending', 'sent', 'skipped'));
