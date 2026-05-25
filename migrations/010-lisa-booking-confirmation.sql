-- 010-lisa-booking-confirmation.sql
-- Lisa F12 — Booking-bevestiging: door de volger opgegeven e-mail/telefoon + GHL-contact-match.
-- Idempotent. Uitvoeren in Supabase SQL Editor. Vereist: lisa_conversations (003/005/007).

BEGIN;

ALTER TABLE lisa_conversations
  ADD COLUMN IF NOT EXISTS confirmed_email text,
  ADD COLUMN IF NOT EXISTS confirmed_phone text,
  ADD COLUMN IF NOT EXISTS booking_match_status text
    CHECK (booking_match_status IS NULL OR booking_match_status IN ('pending','matched','no_match','multiple_matches')),
  ADD COLUMN IF NOT EXISTS booking_match_at timestamptz,
  ADD COLUMN IF NOT EXISTS booking_matched_contact_id text;

COMMENT ON COLUMN lisa_conversations.confirmed_email IS
  'E-mail die de volger in de chat opgaf na booking. Door de AI geëxtraheerd (alleen indien expliciet gegeven).';
COMMENT ON COLUMN lisa_conversations.booking_match_status IS
  'pending: data gevraagd / matched: GHL-contact gevonden (+ evt. appointment gekoppeld) / '
  'no_match: geen GHL-contact / multiple_matches: meerdere ambigue contacten.';

CREATE INDEX IF NOT EXISTS idx_lisa_conversations_email
  ON lisa_conversations(confirmed_email) WHERE confirmed_email IS NOT NULL;

COMMIT;

-- ============================================
-- VERIFICATIE (handmatig in SQL Editor)
-- ============================================
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='lisa_conversations'
--     AND column_name IN ('confirmed_email','confirmed_phone','booking_match_status','booking_match_at','booking_matched_contact_id');
