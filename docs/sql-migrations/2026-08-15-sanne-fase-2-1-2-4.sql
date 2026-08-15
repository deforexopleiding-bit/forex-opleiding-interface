-- 2026-08-15-sanne-fase-2-1-2-4.sql
--
-- Sanne — mail-agent Fases 2.1 t/m 2.4 (reader-card + auto-draft + autonoom + escalatie).
--
-- Alle nieuwe gedrag STAAT UIT via feature_flags in joost_config module='email':
--   sanne_reactive_suggest / sanne_auto_draft_save / sanne_autonomous_send = false.
-- autonomous_mailboxes wordt geïnitialiseerd op [] (leeg) — GEEN mailbox armt zichzelf.
--
-- Idempotent: safe om meerdere keren te draaien.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1) email_drafts: source-kolom voor discriminator (sanne / user / …)
-- ═══════════════════════════════════════════════════════════════════════════
-- Sanne schrijft concepten met source='sanne' zodat de reader een badge kan
-- tonen ("Concept door Sanne") + de Concepten-map ze anders kan sorteren.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'email_drafts') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'email_drafts' AND column_name = 'source'
    ) THEN
      ALTER TABLE email_drafts ADD COLUMN source text;
      CREATE INDEX IF NOT EXISTS idx_email_drafts_source ON email_drafts (source);
    END IF;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2) joost_config module='email' — autonomous_mailboxes: [] (leeg default)
-- ═══════════════════════════════════════════════════════════════════════════
-- Aparte lijst naast mailbox_scope. mailbox_scope = "mag Sanne hier kijken/
-- suggereren"; autonomous_mailboxes = "mag Sanne hier ZELF versturen".
-- Autonomous is STRIKT restrictiever: alleen mailboxen die expliciet aan-
-- gearmd zijn, en alleen als alle andere gates óók slagen.
--
-- jsonb_set met create_if_missing=true; alleen zetten als key nog niet bestaat
-- om productie-config niet te overschrijven.
UPDATE joost_config
SET autonomy_config = jsonb_set(
      COALESCE(autonomy_config, '{}'::jsonb),
      '{autonomous_mailboxes}',
      '[]'::jsonb,
      true
    )
WHERE module = 'email'
  AND (autonomy_config IS NULL OR NOT (autonomy_config ? 'autonomous_mailboxes'));

-- ═══════════════════════════════════════════════════════════════════════════
-- 3) Verificatie (informatief)
-- ═══════════════════════════════════════════════════════════════════════════
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name='email_drafts' AND column_name='source';
--
-- SELECT autonomy_config -> 'autonomous_mailboxes' AS autonomous_mailboxes,
--        autonomy_config -> 'mailbox_scope'        AS mailbox_scope,
--        feature_flags   -> 'sanne_autonomous_send' AS autonomous_send_flag
-- FROM joost_config WHERE module = 'email';
--
-- Verwacht na deze migratie:
--   autonomous_mailboxes = []
--   sanne_autonomous_send = false
-- → geen enkele mailbox verstuurt autonoom. Merge is veilig.
