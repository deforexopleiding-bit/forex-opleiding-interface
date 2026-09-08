-- 2026-09-07-lisa-conv-last-message-at-greatest.sql
--
-- STATUS: TER REVIEW — NIET AUTOMATISCH DRAAIEN.
--
-- PROBLEEM
-- ========
-- De trigger `trg_lisa_msg_update_conv` op `lisa_messages` (uit migratie
-- 003-lisa-tables.sql:165-184) overschrijft `lisa_conversations.last_message_at
-- = NEW.sent_at` bij ELKE insert — óók als NEW.sent_at OUDER is dan de huidige
-- waarde. Bij out-of-order inserts (cron-lisa-conversations-poll die messages
-- levert in GHL-volgorde, en die volgorde is niet gegarandeerd DESC) resulteert
-- dat in verouderde `last_message_at`.
--
-- SYMPTOOM
-- ========
-- Gesprek 'cagayarefx' toont in de UI "22 aug" terwijl er berichten van
-- vandaag (45m / 1u) in `lisa_messages` staan. Sortering `last_message_at
-- DESC` in de list-endpoint duwt daardoor recente gesprekken naar de bodem.
--
-- FIX
-- ===
-- 1. Trigger herschrijven met GREATEST() zodat `last_message_at` alleen naar
--    voren beweegt, nooit terug. Backward-compatible: bij eerste-message-ever
--    is `last_message_at` NULL → GREATEST(NULL, NEW.sent_at) = NEW.sent_at
--    zolang we NULL-safe casten via COALESCE.
-- 2. Idem voor `last_ai_message_at` en `last_user_message_at` — dezelfde
--    kolommen hadden dezelfde bug (elke insert overschrijft ongeacht ouder/
--    nieuwer). GREATEST(COALESCE(kolom, epoch), CASE...END) fix.
-- 3. Eenmalige backfill: recompute `last_message_at` (en de _ai_ / _user_
--    varianten) uit `max(sent_at)` per conversatie, gefilterd op direction/
--    ai_generated om de originele semantiek te respecteren.
--
-- 0 incasso-writes; raakt alleen lisa_* tabellen + de trigger-functie.
-- Idempotent: CREATE OR REPLACE FUNCTION + backfill met deterministische
-- max()-berekening. Herhaalde run = zelfde resultaat.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════
-- 1) Trigger-functie herschrijven met GREATEST-guard
-- ═══════════════════════════════════════════════════════════════════════
--
-- COALESCE(kolom, '-infinity'::timestamptz) zorgt dat GREATEST correct werkt
-- als de kolom NULL is (eerste message ever). Op Postgres:
--   GREATEST(NULL, x) = x
-- maar via COALESCE zijn we expliciet en robuust voor eventuele engine-drift.

CREATE OR REPLACE FUNCTION update_lisa_conv_timestamps()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE lisa_conversations
  SET last_message_at = GREATEST(
        COALESCE(last_message_at, '-infinity'::timestamptz),
        NEW.sent_at
      ),
      last_ai_message_at = CASE
        WHEN NEW.direction = 'out' AND NEW.ai_generated
        THEN GREATEST(
          COALESCE(last_ai_message_at, '-infinity'::timestamptz),
          NEW.sent_at
        )
        ELSE last_ai_message_at
      END,
      last_user_message_at = CASE
        WHEN NEW.direction = 'in'
        THEN GREATEST(
          COALESCE(last_user_message_at, '-infinity'::timestamptz),
          NEW.sent_at
        )
        ELSE last_user_message_at
      END
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger zelf hoeft niet opnieuw aangemaakt — CREATE OR REPLACE FUNCTION
-- is genoeg. De trigger blijft aan dezelfde functie hangen.
-- (Voor de zekerheid: verifieer met "SELECT tgname FROM pg_trigger WHERE
-- tgrelid = 'lisa_messages'::regclass;")

-- ═══════════════════════════════════════════════════════════════════════
-- 2) Eenmalige backfill: recompute last_message_at + varianten
-- ═══════════════════════════════════════════════════════════════════════
--
-- Berekent per conversatie:
--   last_message_at      = max(sent_at) over alle messages
--   last_ai_message_at   = max(sent_at) waar direction='out' AND ai_generated
--   last_user_message_at = max(sent_at) waar direction='in'
--
-- Alleen UPDATE als de bestaande waarde ACHTERLOOPT op de correcte max().
-- Zo raken conversaties zonder drift niet aan (idempotent + goedkoop).
-- COALESCE zodat NULL <-> gevulde vergelijking correct is.

UPDATE lisa_conversations c
SET last_message_at      = agg.max_all,
    last_ai_message_at   = agg.max_ai,
    last_user_message_at = agg.max_user
FROM (
  SELECT conversation_id,
         max(sent_at)                                                       AS max_all,
         max(sent_at) FILTER (WHERE direction = 'out' AND ai_generated)     AS max_ai,
         max(sent_at) FILTER (WHERE direction = 'in')                       AS max_user
  FROM lisa_messages
  GROUP BY conversation_id
) agg
WHERE c.id = agg.conversation_id
  AND (
    c.last_message_at IS DISTINCT FROM agg.max_all
    OR c.last_ai_message_at IS DISTINCT FROM agg.max_ai
    OR c.last_user_message_at IS DISTINCT FROM agg.max_user
  );

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICATIE — draai NA COMMIT in aparte tab
-- ═══════════════════════════════════════════════════════════════════════
--
-- 1. Drift-check: er MAG geen conv meer zijn waar max(sent_at) > last_message_at.
--
--    SELECT c.id, c.contact_name, c.last_message_at AS conv_laatst,
--           m.max_msg,
--           (m.max_msg - c.last_message_at) AS drift
--      FROM lisa_conversations c
--      JOIN (SELECT conversation_id, max(sent_at) AS max_msg
--              FROM lisa_messages GROUP BY 1) m
--        ON m.conversation_id = c.id
--     WHERE c.is_sandbox = false
--       AND m.max_msg > c.last_message_at
--     ORDER BY drift DESC LIMIT 50;
--    -- Verwacht: 0 rijen.
--
-- 2. Spot-check op 'cagayarefx' — last_message_at moet nu de recentste
--    message-timestamp reflecteren:
--
--    SELECT c.id, c.contact_name, c.instagram_handle, c.last_message_at,
--           (SELECT max(sent_at) FROM lisa_messages WHERE conversation_id = c.id) AS max_msg
--      FROM lisa_conversations c
--     WHERE lower(c.instagram_handle) LIKE '%cagayarefx%'
--        OR lower(c.contact_name) LIKE '%cagayarefx%';
--
-- 3. Nieuwe insert-test — trigger moet nu NIET terug in de tijd:
--
--    -- Simulate een historisch bericht dat achteraf binnenkomt.
--    INSERT INTO lisa_messages (conversation_id, direction, content, sent_at, ai_generated)
--    VALUES (
--      (SELECT id FROM lisa_conversations WHERE is_sandbox=false ORDER BY last_message_at DESC NULLS LAST LIMIT 1),
--      'in', 'historische-test', now() - interval '90 days', false
--    );
--    -- Verwacht: last_message_at van die conversatie is NIET verlaagd.
--    -- Cleanup: DELETE dat test-message via id.

-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK (indien nodig)
-- ═══════════════════════════════════════════════════════════════════════
--
-- BEGIN;
--   CREATE OR REPLACE FUNCTION update_lisa_conv_timestamps()
--   RETURNS TRIGGER AS $$
--   BEGIN
--     UPDATE lisa_conversations
--     SET last_message_at = NEW.sent_at,
--         last_ai_message_at = CASE
--           WHEN NEW.direction = 'out' AND NEW.ai_generated
--           THEN NEW.sent_at ELSE last_ai_message_at END,
--         last_user_message_at = CASE
--           WHEN NEW.direction = 'in'
--           THEN NEW.sent_at ELSE last_user_message_at END
--     WHERE id = NEW.conversation_id;
--     RETURN NEW;
--   END;
--   $$ LANGUAGE plpgsql;
-- COMMIT;
--
-- LET OP: rollback herstelt alleen de trigger-functie. De backfill van
-- last_message_at is niet terug te draaien zonder aparte snapshot — maar
-- omdat backfill de correcte waarde zet, is er ook geen reden om terug
-- te willen (rollback trigger + laten staan = ook OK).
