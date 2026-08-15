-- 2026-08-15-email-v2-fase-2b.sql
--
-- Fase 2B mailmodule (v2 E-mail, PR #1289 feat/v2-email):
--   - email_messages krijgt flagged + status voor Vlag/Archief/Prullenbak.
--   - email_drafts nieuwe tabel voor Concepten-map (autosave + draft-delete).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS.
-- Verwacht op productie te draaien VÓÓR de nieuwe endpoints live gaan;
-- endpoints hebben runtime-detect en tonen een nette error als de kolommen
-- niet bestaan, dus geen crash bij out-of-order deploy.

-- ── email_messages: flag + status ────────────────────────────────────
ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS flagged boolean NOT NULL DEFAULT false;

-- CHECK constraint tolerant toevoegen — als hij al bestaat, negeer.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'email_messages' AND column_name = 'status'
  ) THEN
    ALTER TABLE email_messages
      ADD COLUMN status text NOT NULL DEFAULT 'inbox'
      CHECK (status IN ('inbox','archived','trashed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_email_messages_status
  ON email_messages (status);

CREATE INDEX IF NOT EXISTS idx_email_messages_flagged
  ON email_messages (flagged) WHERE flagged = true;

-- ── email_drafts: Concepten-map ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  from_mailbox text,
  to_address text,
  cc_address text,
  bcc_address text,
  subject text,
  body_html text,
  in_reply_to_email_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_drafts_user_updated
  ON email_drafts (user_id, updated_at DESC);

-- RLS: gebruiker ziet alleen eigen drafts.
ALTER TABLE email_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_drafts_own_select ON email_drafts;
CREATE POLICY email_drafts_own_select ON email_drafts
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS email_drafts_own_insert ON email_drafts;
CREATE POLICY email_drafts_own_insert ON email_drafts
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS email_drafts_own_update ON email_drafts;
CREATE POLICY email_drafts_own_update ON email_drafts
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS email_drafts_own_delete ON email_drafts;
CREATE POLICY email_drafts_own_delete ON email_drafts
  FOR DELETE USING (auth.uid() = user_id);
