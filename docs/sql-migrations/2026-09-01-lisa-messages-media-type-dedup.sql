-- ============================================================================
-- BP3 · Instagram ontbrekende berichten fix — schema-uitbreidingen
-- 2026-09-01
--
-- Twee wijzigingen op lisa_messages, ter voorbereiding op code-fix #1 (media
-- placeholder-opslag) en #4 (atomic dedup):
--
--   A) message_type-kolom (nullable text, default 'text') — labelt media-
--      berichten (photo/video/audio/reel/story_reply/sticker/file/text/
--      unknown). Backfill bestaande rijen op 'text' zodat de kolom
--      historisch consistent is.
--
--   B) Bestaande duplicaten op ghl_message_id opruimen (behoud oudste rij
--      per ghl_message_id via sent_at ASC, ties → id ASC) ZODAT de UNIQUE-
--      constraint in stap C niet faalt.
--
--   C) Partial UNIQUE-index op ghl_message_id WHERE NOT NULL. Zo kunnen
--      code-inserts overstappen op `ON CONFLICT (ghl_message_id) DO NOTHING`
--      voor atomaire dedup (huidige SELECT-then-INSERT is race-vatbaar).
--      Interne outbound berichten met ghl_message_id=NULL blijven mogelijk
--      (partial-index sluit die uit).
--
-- INCASSO-VEILIG: raakt uitsluitend public.lisa_messages. Geen finance/
-- dunning/arrangement-tabellen.
--
-- IDEMPOTENT: gebruikt IF NOT EXISTS / IF EXISTS overal; herhaald draaien
-- veilig. De dedup-stap is een DELETE die alleen rijen raakt met
-- ghl_message_id gedeeld door meerdere rijen; tweede run vindt niets meer.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- PRE-CHECK QUERIES (READ-ONLY — draai eerst, deel resultaat)
-- ═══════════════════════════════════════════════════════════════════════════
--
--   -- Aantal duplicaten dat opgeruimd zal worden:
--   SELECT count(*) - count(DISTINCT ghl_message_id) AS te_verwijderen_duplicaten
--   FROM public.lisa_messages
--   WHERE ghl_message_id IS NOT NULL;
--
--   -- Detail per gedupliceerde ghl_message_id (top 20):
--   SELECT ghl_message_id, count(*) AS n, min(sent_at) AS oudste, max(sent_at) AS jongste
--   FROM public.lisa_messages
--   WHERE ghl_message_id IS NOT NULL
--   GROUP BY ghl_message_id
--   HAVING count(*) > 1
--   ORDER BY n DESC, ghl_message_id
--   LIMIT 20;
--
--   -- Verwachte start-toestand van message_type na backfill:
--   -- (nog niets — kolom bestaat nog niet; na migratie: 100% 'text').
--
-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRATIE
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- A) message_type-kolom
-- ─────────────────────────────────────────────────────────────────────────
-- Nullable text met default 'text'. Bestaande rijen krijgen 'text' via de
-- default (default wordt bij ADD COLUMN op alle bestaande rijen toegepast
-- in PG11+). CHECK-constraint whitelist bekende types + 'unknown' voor
-- forward-compat als GHL nieuwe typen introduceert.
ALTER TABLE public.lisa_messages
  ADD COLUMN IF NOT EXISTS message_type text NOT NULL DEFAULT 'text';

-- Whitelist. 'text' voor tekstberichten; media-varianten voor de placeholder-
-- flow uit code-fix #1. 'unknown' = ontvangen zonder herkenbaar type maar
-- wel een bericht — beter opslaan dan droppen.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lisa_messages_message_type_check'
  ) THEN
    ALTER TABLE public.lisa_messages
      ADD CONSTRAINT lisa_messages_message_type_check
      CHECK (message_type IN (
        'text','photo','video','audio','reel','story_reply',
        'sticker','file','unknown'
      ));
  END IF;
END$$;

-- Defensieve backfill: bestaande rijen die (om welke reden dan ook) NULL
-- kregen worden op 'text' gezet. Bij een verse migratie is dit een no-op.
UPDATE public.lisa_messages SET message_type = 'text' WHERE message_type IS NULL;

COMMENT ON COLUMN public.lisa_messages.message_type IS
  'BP3 (2026-09-01): berichttype uit GHL/IG. text = normaal tekstbericht; '
  'photo/video/audio/reel/story_reply/sticker/file = media-varianten met '
  'placeholder-content; unknown = bericht met onbekend type maar wel echt '
  'ontvangen. Aangedreven door lisa-ghl-webhook.js + cron-lisa-conversations-poll.js.';

-- ─────────────────────────────────────────────────────────────────────────
-- B) Dedupe vóór UNIQUE-index — vereist, anders faalt de CREATE
-- ─────────────────────────────────────────────────────────────────────────
-- Behoud per ghl_message_id de OUDSTE rij (sent_at ASC; bij gelijke tijd
-- id ASC voor determinisme). Verwijder de rest. NULL ghl_message_id blijft
-- ongemoeid (partial-index dekt die niet).
--
-- Gebruikt een CTE met ROW_NUMBER — vereist rn > 1 in de DELETE-subquery.
WITH gerangschikt AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY ghl_message_id
           ORDER BY sent_at ASC, id ASC
         ) AS rn
  FROM public.lisa_messages
  WHERE ghl_message_id IS NOT NULL
),
te_verwijderen AS (
  SELECT id FROM gerangschikt WHERE rn > 1
)
DELETE FROM public.lisa_messages
WHERE id IN (SELECT id FROM te_verwijderen);

-- ─────────────────────────────────────────────────────────────────────────
-- C) Partial UNIQUE-index op ghl_message_id
-- ─────────────────────────────────────────────────────────────────────────
-- CONCURRENTLY kan NIET binnen een transactie draaien; voor tabellen van
-- deze schaal is de non-CONCURRENTLY variant snel genoeg en houdt de hele
-- migratie atomair. Post-check hieronder telt duplicaten (moet 0 zijn) en
-- verifieert dat de index bestaat.
--
-- IF NOT EXISTS → tweede run is een no-op.
CREATE UNIQUE INDEX IF NOT EXISTS lisa_messages_ghl_msg_id_uniq
  ON public.lisa_messages (ghl_message_id)
  WHERE ghl_message_id IS NOT NULL;

COMMENT ON INDEX public.lisa_messages_ghl_msg_id_uniq IS
  'BP3 (2026-09-01): partial UNIQUE zodat webhook+poll met '
  'ON CONFLICT (ghl_message_id) DO NOTHING atomair kunnen dedupen. '
  'Interne outbound berichten (ghl_message_id IS NULL) worden niet gedekt.';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- POST-CHECK QUERIES (draai na migratie, verifieer)
-- ═══════════════════════════════════════════════════════════════════════════
--
--   -- 1. Nul duplicaten?
--   SELECT count(*) - count(DISTINCT ghl_message_id) AS resterende_duplicaten
--   FROM public.lisa_messages
--   WHERE ghl_message_id IS NOT NULL;
--   -- Verwacht: 0
--
--   -- 2. UNIQUE-index bestaat?
--   SELECT indexname, indexdef
--   FROM pg_indexes
--   WHERE tablename = 'lisa_messages'
--     AND indexname = 'lisa_messages_ghl_msg_id_uniq';
--   -- Verwacht: 1 rij, indexdef bevat UNIQUE + WHERE (ghl_message_id IS NOT NULL).
--
--   -- 3. message_type-kolom + backfill?
--   SELECT message_type, count(*)
--   FROM public.lisa_messages
--   GROUP BY 1
--   ORDER BY 2 DESC;
--   -- Verwacht: 'text' = totaal aantal bestaande rijen (rest 0 tot code live gaat).
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK (indien nodig — draai handmatig, niet automatisch)
-- ═══════════════════════════════════════════════════════════════════════════
--
--   BEGIN;
--     DROP INDEX IF EXISTS public.lisa_messages_ghl_msg_id_uniq;
--     ALTER TABLE public.lisa_messages
--       DROP CONSTRAINT IF EXISTS lisa_messages_message_type_check,
--       DROP COLUMN IF EXISTS message_type;
--   COMMIT;
--   -- De dedupe-DELETE kan NIET worden teruggedraaid (rijen zijn weg);
--   -- rollback verwijdert enkel de schema-additions. Backup de tabel
--   -- vóór de migratie als je de duplicaten wilt kunnen herstellen.
-- ============================================================================
