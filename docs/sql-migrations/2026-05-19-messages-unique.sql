-- Migratie: UNIQUE constraint op ghl_message_id voor follow_up_messages
-- Datum: 2026-05-19
-- Vereist: dubbele rijen EERST handmatig opruimen (zie diagnose-query hieronder)
--
-- DIAGNOSE-QUERY (run eerst in Supabase om dups te zoeken):
--
--   SELECT ghl_message_id, COUNT(*) as cnt
--   FROM follow_up_messages
--   GROUP BY ghl_message_id
--   HAVING COUNT(*) > 1
--   ORDER BY cnt DESC
--   LIMIT 20;
--
-- ALS er duplicaten zijn: dedupe eerst via:
--   DELETE FROM follow_up_messages
--   WHERE id NOT IN (
--     SELECT DISTINCT ON (ghl_message_id) id
--     FROM follow_up_messages
--     ORDER BY ghl_message_id, created_at ASC
--   );
--
-- Daarna pas deze migratie runnen:

ALTER TABLE follow_up_messages
  ADD CONSTRAINT follow_up_messages_ghl_message_id_unique
  UNIQUE (ghl_message_id);

-- ROLLBACK:
-- ALTER TABLE follow_up_messages DROP CONSTRAINT follow_up_messages_ghl_message_id_unique;
