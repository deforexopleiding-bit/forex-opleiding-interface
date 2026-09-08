-- 2026-09-07-lisa-messages-unique-ghl-message-id.sql
--
-- STATUS: TER REVIEW — NIET AUTOMATISCH DRAAIEN.
--
-- PROBLEEM
-- ========
-- Instagram-gesprekken tonen duplicaten van dezelfde inbound message
-- (bv. "Ik ben zelf PAS actief.", "Yay"). Twee ingest-paden schrijven
-- in lisa_messages (webhook + poll) en vertrouwen op de 23505-catch
-- als dedup-mechanisme:
--   - api/lisa-ghl-webhook.js:189-207     (INSERT + catch 23505)
--   - api/cron-lisa-conversations-poll.js:325-345 (INSERT + catch 23505)
--
-- MAAR: er is GEEN unique-constraint op ghl_message_id in de DB — alleen
-- een NON-UNIQUE partial index (migratie 003-lisa-tables.sql:159-160):
--
--   CREATE INDEX IF NOT EXISTS idx_lisa_msg_ghl
--     ON lisa_messages(ghl_message_id) WHERE ghl_message_id IS NOT NULL;
--
-- Gevolg: 23505 vuurt NOOIT, want er is geen unique-violation mogelijk.
-- Beide paden kunnen dezelfde ghl_message_id inserten (race tussen
-- webhook + poll, of GHL-retry-delivery met identieke messageId).
--
-- FIX
-- ===
-- 1. Cleanup bestaande duplicaten (houdt kleinste id per ghl_message_id).
-- 2. Vervang de non-unique index door een partial UNIQUE index. Volgorde
--    is kritiek: unique-index-create faalt als duplicaten nog bestaan.
--
-- Na deze migratie vuurt de 23505-catch in webhook + poll automatisch —
-- geen JS-wijziging nodig. Beide code-paden hebben de catch al.
--
-- Vergelijking: follow_up_messages heeft dit al sinds
-- docs/sql-migrations/2026-05-19-messages-unique.sql. Deze migratie
-- brengt lisa_messages op dezelfde standaard.
--
-- 0 incasso-writes. Raakt uitsluitend lisa_messages + z'n index.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════
-- 1) Cleanup bestaande duplicaten
-- ═══════════════════════════════════════════════════════════════════════
--
-- Houd de rij met de KLEINSTE id per ghl_message_id — die kwam er
-- typisch eerst in (uuids zijn geen strict chronological maar wel
-- deterministisch voor deduplicatie). Alternatief zou 'oudste sent_at'
-- zijn, maar sent_at kan gelijk zijn bij simultane inserts terwijl
-- id gegarandeerd uniek is.
--
-- Uitleg: voor elke rij `a`, join `b` op dezelfde ghl_message_id met
-- een KLEINERE id. Als zo'n b bestaat, is a een duplicaat en wordt hij
-- verwijderd. De rij met de kleinste id per groep heeft geen kleinere
-- partner en overleeft.

DELETE FROM lisa_messages a
  USING lisa_messages b
 WHERE a.ghl_message_id IS NOT NULL
   AND a.ghl_message_id = b.ghl_message_id
   AND a.id > b.id;

-- ═══════════════════════════════════════════════════════════════════════
-- 2) Vervang non-unique index door partial UNIQUE index
-- ═══════════════════════════════════════════════════════════════════════
--
-- De WHERE-clause houdt NULL-rijen (system-messages zonder
-- ghl_message_id, bv. lisa-respond.js AI-system-notes) buiten de
-- unique-guard. Zonder de WHERE zou een tweede NULL-insert falen.

DROP INDEX IF EXISTS idx_lisa_msg_ghl;

CREATE UNIQUE INDEX IF NOT EXISTS idx_lisa_msg_ghl_unique
  ON lisa_messages(ghl_message_id)
  WHERE ghl_message_id IS NOT NULL;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICATIE — draai NA COMMIT in aparte tab
-- ═══════════════════════════════════════════════════════════════════════
--
-- 1. Geen duplicaten meer:
--    SELECT ghl_message_id, count(*) FROM lisa_messages
--     WHERE ghl_message_id IS NOT NULL
--     GROUP BY 1 HAVING count(*) > 1
--     ORDER BY 2 DESC LIMIT 20;
--    -- Verwacht: 0 rijen.
--
-- 2. Unique-index staat scherp:
--    SELECT indexname, indexdef FROM pg_indexes
--     WHERE tablename = 'lisa_messages' AND indexname LIKE 'idx_lisa_msg_ghl%';
--    -- Verwacht: idx_lisa_msg_ghl_unique met CREATE UNIQUE INDEX ... WHERE
--
-- 3. Duplicate-insert-test (moet nu falen met 23505):
--    -- Kies een bestaande ghl_message_id:
--    -- SELECT ghl_message_id FROM lisa_messages
--    --  WHERE ghl_message_id IS NOT NULL LIMIT 1;
--    --
--    -- INSERT INTO lisa_messages (conversation_id, direction, content, ai_generated, ghl_message_id)
--    -- VALUES (
--    --   (SELECT id FROM lisa_conversations LIMIT 1),
--    --   'in', 'dup-test', false, '<bestaande-ghl-id>'
--    -- );
--    -- Verwacht: SQLSTATE 23505 duplicate key error.
--
-- 4. NULL-inserts blijven werken (system-messages zonder ghl_message_id):
--    -- INSERT INTO lisa_messages (conversation_id, direction, content, ai_generated)
--    -- VALUES ((SELECT id FROM lisa_conversations LIMIT 1), 'out', 'null-test-1', false);
--    -- INSERT INTO lisa_messages (conversation_id, direction, content, ai_generated)
--    -- VALUES ((SELECT id FROM lisa_conversations LIMIT 1), 'out', 'null-test-2', false);
--    -- Verwacht: allebei slagen (partial-unique excludeert NULL).
--    -- Cleanup: DELETE via inhoud van 'null-test-*'.

-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK (indien nodig)
-- ═══════════════════════════════════════════════════════════════════════
--
-- BEGIN;
--   DROP INDEX IF EXISTS idx_lisa_msg_ghl_unique;
--   CREATE INDEX IF NOT EXISTS idx_lisa_msg_ghl
--     ON lisa_messages(ghl_message_id)
--     WHERE ghl_message_id IS NOT NULL;
-- COMMIT;
--
-- LET OP: rollback herstelt alleen de index-shape. De cleanup van
-- duplicaten (DELETE) is niet terug te draaien zonder aparte snapshot.
-- Duplicaten zaten er onbedoeld — teruggeven aan de DB heeft geen
-- zinnige reden, behalve puur audit/forensic scenario's.
