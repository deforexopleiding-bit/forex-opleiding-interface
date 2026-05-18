-- Migratie: UNIQUE constraint op follow_up_outcomes.appointment_id
-- Datum: 2026-05-19
-- Reden: voorkomen dubbele outcomes per appointment (Item 7 Fase 6.1)
-- Vereist: dubbele rijen handmatig opgeruimd vooraf via Supabase UI
-- Geverifieerd: 0 duplicates in productie vóór deze migratie

ALTER TABLE follow_up_outcomes
  ADD CONSTRAINT follow_up_outcomes_appointment_id_unique
  UNIQUE (appointment_id);

-- ROLLBACK:
-- ALTER TABLE follow_up_outcomes DROP CONSTRAINT follow_up_outcomes_appointment_id_unique;
