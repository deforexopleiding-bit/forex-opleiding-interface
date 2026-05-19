-- Migratie: source 'polling_sync' → 'poll' voor consistentie
-- Datum: 2026-05-19
-- Reden: naming-consistency met andere sources ('webhook', 'manual')

UPDATE follow_up_messages
SET source = 'poll'
WHERE source = 'polling_sync';

-- ROLLBACK:
-- UPDATE follow_up_messages SET source = 'polling_sync' WHERE source = 'poll';
