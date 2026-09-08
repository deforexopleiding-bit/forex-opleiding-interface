-- 2026-09-07-lisa-messages-unique-ghl-message-id.sql
--
-- STATUS: TER REVIEW — NIET AUTOMATISCH DRAAIEN.
--
-- HERZIENING v2 (2026-09-07): PR #1520 v1 had de non-NULL cleanup (a.id > b.id
-- op ghl_message_id) — dat mist de belangrijke case: dubbele inbound-berichten
-- waarvan ÉÉN rij een NULL ghl_message_id heeft. Bewijs uit productie:
--   conv 7611d2b7, content 'Ik ben zelf PAS actief.', 2 rijen ~3s uit elkaar:
--     rij 1: 19:14:25.957 · ghl_message_id = 'ZihKLxoGWvQ86elxKjGc'
--     rij 2: 19:14:28.774 · ghl_message_id = NULL
-- De partial UNIQUE index (WHERE NOT NULL) vangt die NULL-rij niet.
--
-- Combinatie-fix: (a) code-fix in api/lisa-ghl-webhook.js die de webhook
-- skip't zodra messageId ontbreekt — poll-cron ingest 'em alsnog met de
-- correcte id; (b) deze SQL doet cleanup van bestaande NULL-tweeling-rijen
-- + brengt de partial UNIQUE index aan voor toekomstige inserts.
--
-- Cleanup-regel: verwijder rij MET NULL alleen als er een TWEELING bestaat
-- met NON-NULL id + identieke conversation_id + direction + content + sent_at
-- binnen 60 seconden. Zo blijven legitieme herhaalde berichten ("Yay" / "Yay"
-- kort na elkaar, elk met eigen id) ongemoeid.
--
-- 0 incasso. Raakt uitsluitend lisa_messages + z'n index.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════
-- 1) Cleanup: NULL-tweelingen (rij met NULL id die duplicaat is van rij
--    met wél een id, binnen 60s + zelfde inhoud + zelfde direction)
-- ═══════════════════════════════════════════════════════════════════════

DELETE FROM lisa_messages null_row
 USING lisa_messages twin
 WHERE null_row.ghl_message_id IS NULL
   AND twin.ghl_message_id IS NOT NULL
   AND null_row.conversation_id = twin.conversation_id
   AND null_row.direction       = twin.direction
   AND null_row.content         = twin.content
   AND abs(EXTRACT(EPOCH FROM (null_row.sent_at - twin.sent_at))) <= 60;

-- ═══════════════════════════════════════════════════════════════════════
-- 2) Cleanup: klassieke dubbelen op NON-NULL ghl_message_id
--    (voor het geval de webhook toch 2× hetzelfde id insertte — race, of
--    poll + webhook op zelfde moment vóór de code-fix)
-- ═══════════════════════════════════════════════════════════════════════

DELETE FROM lisa_messages a
  USING lisa_messages b
 WHERE a.ghl_message_id IS NOT NULL
   AND a.ghl_message_id = b.ghl_message_id
   AND a.id > b.id;

-- ═══════════════════════════════════════════════════════════════════════
-- 3) Partial UNIQUE index (vervangt de non-unique idx_lisa_msg_ghl)
-- ═══════════════════════════════════════════════════════════════════════
--
-- Blijft partial (WHERE NOT NULL) omdat er legitieme system-messages zonder
-- ghl_message_id bestaan (lisa-respond.js system-notes, lisa-followup out).
-- Voor inbound is de webhook nu gefixt om te skippen bij NULL — dus geen
-- nieuwe NULL-tweeling meer. De poll-cron blijft de bron van waarheid met
-- id + 23505-catch.

DROP INDEX IF EXISTS idx_lisa_msg_ghl;

CREATE UNIQUE INDEX IF NOT EXISTS idx_lisa_msg_ghl_unique
  ON lisa_messages(ghl_message_id)
  WHERE ghl_message_id IS NOT NULL;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICATIE — draai NA COMMIT in aparte tab
-- ═══════════════════════════════════════════════════════════════════════
--
-- 1. Geen NULL-tweelingen meer:
--    SELECT n.id AS null_id, n.sent_at, t.id AS twin_id, t.ghl_message_id, t.sent_at
--      FROM lisa_messages n
--      JOIN lisa_messages t
--        ON t.conversation_id = n.conversation_id
--       AND t.direction       = n.direction
--       AND t.content         = n.content
--       AND t.ghl_message_id IS NOT NULL
--       AND abs(EXTRACT(EPOCH FROM (n.sent_at - t.sent_at))) <= 60
--     WHERE n.ghl_message_id IS NULL;
--    -- Verwacht: 0 rijen.
--
-- 2. Geen NON-NULL duplicaten meer:
--    SELECT ghl_message_id, count(*) FROM lisa_messages
--     WHERE ghl_message_id IS NOT NULL
--     GROUP BY 1 HAVING count(*) > 1;
--    -- Verwacht: 0 rijen.
--
-- 3. Unique-index staat:
--    SELECT indexname, indexdef FROM pg_indexes
--     WHERE tablename = 'lisa_messages' AND indexname LIKE 'idx_lisa_msg_ghl%';
--    -- Verwacht: idx_lisa_msg_ghl_unique met UNIQUE + WHERE NOT NULL.
--
-- 4. Spot-check op conv 7611d2b7 ('Ik ben zelf PAS actief.'):
--    SELECT id, direction, content, sent_at, ghl_message_id
--      FROM lisa_messages
--     WHERE conversation_id = '7611d2b7...'  -- vul volledige uuid in
--       AND content ILIKE '%Ik ben zelf PAS actief%'
--     ORDER BY sent_at;
--    -- Verwacht: 1 rij i.p.v. 2. De rij met ghl_message_id='ZihKL...' blijft.
--
-- 5. NULL-inserts blijven werken voor legitieme system-messages:
--    (bv. AI-refusal-notes uit lisa-ghl-webhook.js:289 en lisa-respond.js)
--    → deze zetten géén ghl_message_id, bevatten unieke content per insert,
--    en vallen niet binnen de NULL-tweeling-regel. Geen impact.

-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════
--
-- BEGIN;
--   DROP INDEX IF EXISTS idx_lisa_msg_ghl_unique;
--   CREATE INDEX IF NOT EXISTS idx_lisa_msg_ghl
--     ON lisa_messages(ghl_message_id)
--     WHERE ghl_message_id IS NOT NULL;
-- COMMIT;
--
-- De DELETE-cleanup is niet reversibel zonder snapshot. Duplicaten hadden
-- er niet moeten zijn, dus geen operationele reden om terug te draaien.
