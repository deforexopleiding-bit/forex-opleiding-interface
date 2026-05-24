-- 009-lisa-system-messages.sql
-- Lisa F11 — Systeem-events in de berichtenthread (appointment booked, no-show, etc.).
-- Idempotent. Uitvoeren in Supabase SQL Editor. Vereist: lisa_messages (003).

BEGIN;

ALTER TABLE lisa_messages
  ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN lisa_messages.is_system IS
  'True voor systeem-events (appointment booked/no-show/etc). Niet AI-gegenereerd, '
  'niet door de volger gestuurd — alleen een logregel in de thread.';

CREATE INDEX IF NOT EXISTS idx_lisa_messages_system
  ON lisa_messages(conversation_id) WHERE is_system = true;

COMMIT;

-- ============================================
-- VERIFICATIE (handmatig in SQL Editor)
-- ============================================
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='lisa_messages' AND column_name='is_system';
