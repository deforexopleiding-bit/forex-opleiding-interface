-- ============================================================================
-- BP3 · Instagram media-attachments — schema-uitbreiding
-- 2026-09-02
--
-- Voegt attachment_url-kolom toe aan lisa_messages zodat de webhook + poll-
-- cron de attachment-URL uit GHL's Message Attachments-veld kunnen opslaan.
-- De code-fix (parseAttachments + typeFromUrl in api/_lib/lisa-message-type.js
-- + render in modules/klanten-v2/views/lisa-v2.js) volgt na akkoord op deze
-- migratie.
--
-- Nullable text — text-berichten hebben geen attachment; media-berichten
-- krijgen de eerste URL. Bij meerdere attachments per bericht (bv. carousel)
-- pakken we in de code de eerste — extra attachments kunnen later in een
-- aparte tabel als dat nodig blijkt (geen enkelvoudig geval bekend nu).
--
-- INCASSO-VEILIG: raakt uitsluitend public.lisa_messages. Geen finance/
-- dunning/arrangement-tabellen.
--
-- IDEMPOTENT: IF NOT EXISTS → herhaald draaien is een no-op.
--
-- BLOKKEREND: de code-PR schrijft ALTIJD attachment_url mee (NULL bij text),
-- dus zonder deze migratie faalt elke insert met column-error 42703. Draai
-- deze migratie VÓÓR of DIRECT NA de code-deploy.
-- ============================================================================

BEGIN;

ALTER TABLE public.lisa_messages
  ADD COLUMN IF NOT EXISTS attachment_url text NULL;

COMMENT ON COLUMN public.lisa_messages.attachment_url IS
  'BP3 (2026-09-02): eerste attachment-URL voor media-berichten (photo/video/'
  'audio/file). NULL voor text-berichten. Aangedreven door parseAttachments() '
  'in api/_lib/lisa-message-type.js — leest GHL Message Attachments in alle '
  'voorkomende vormen (array, JSON-string, komma-gescheiden, losse URL).';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- POST-CHECK
-- ═══════════════════════════════════════════════════════════════════════════
--
--   -- 1. Kolom bestaat?
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='lisa_messages'
--     AND column_name='attachment_url';
--   -- Verwacht: 1 rij, text, YES.
--
--   -- 2. Bestaande rijen ongemoeid (attachment_url = NULL overal)?
--   SELECT count(*) FILTER (WHERE attachment_url IS NULL) AS null_count,
--          count(*) FILTER (WHERE attachment_url IS NOT NULL) AS filled_count,
--          count(*) AS total
--   FROM public.lisa_messages;
--   -- Verwacht: null_count = total, filled_count = 0.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK (indien nodig)
-- ═══════════════════════════════════════════════════════════════════════════
--
--   BEGIN;
--     ALTER TABLE public.lisa_messages DROP COLUMN IF EXISTS attachment_url;
--   COMMIT;
--   -- Verwijdert enkel de kolom; bestaande text/media-rijen blijven ongemoeid.
-- ============================================================================
