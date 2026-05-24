-- 008-lisa-response-delay-queue.sql
-- Lisa F10.5 — Queue-based response-delay: in-kantooruren antwoorden worden vooraf gegenereerd
-- en met menselijke vertraging via de cron verstuurd (niet meer blocking in de webhook).
-- Idempotent. Uitvoeren in Supabase SQL Editor. Vereist: lisa_followups/lisa_messages (003/005/006).

BEGIN;

-- Onderscheidt response-delay (binnen kantooruren) van delayed-response (buiten kantooruren)
-- en regular-followup. De cron routeert op deze vlag.
ALTER TABLE lisa_followups
  ADD COLUMN IF NOT EXISTS is_response_delay boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN lisa_followups.is_response_delay IS
  'True voor in-kantooruren antwoorden die met menselijke vertraging verzonden worden (cron-branch).';

CREATE INDEX IF NOT EXISTS idx_lisa_followups_response_delay
  ON lisa_followups(scheduled_for)
  WHERE is_response_delay = true AND status = 'scheduled';

-- Spiegelvlag op lisa_messages (voor stats — onderscheidt vertraagd-verzonden directe antwoorden).
ALTER TABLE lisa_messages
  ADD COLUMN IF NOT EXISTS is_response_delay boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN lisa_messages.is_response_delay IS
  'True als dit out-bericht via de response-delay queue is verzonden (i.p.v. direct).';

COMMIT;

-- ============================================
-- VERIFICATIE (handmatig in SQL Editor)
-- ============================================
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name IN ('lisa_followups','lisa_messages') AND column_name='is_response_delay';
