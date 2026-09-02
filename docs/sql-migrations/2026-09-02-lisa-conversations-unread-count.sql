-- ============================================================================
-- BP3 · Lisa/Instagram unread-count kolom — schema-uitbreiding
-- 2026-09-02
--
-- Voegt unread_count-kolom toe aan lisa_conversations. Bij elk inbound-bericht
-- (webhook + poll-cron) verhoogt de code deze counter met 1. Bij openen van
-- het gesprek (frontend) wordt 'ie via PATCH ?id= op 0 gezet.
--
-- Zonder deze kolom kan de UI geen betrouwbaar ongelezen-onderscheid maken.
-- Spiegelt whatsapp_conversations.unread_count (bestaande patroon).
--
-- INCASSO-VEILIG: raakt uitsluitend public.lisa_conversations. Geen finance/
-- dunning/arrangement-tabellen.
--
-- IDEMPOTENT: IF NOT EXISTS → herhaald draaien is een no-op.
--
-- BLOKKEREND: de code-PR schrijft ALTIJD unread_count mee (increment bij
-- inbound, reset bij PATCH). Zonder kolom faalt de INSERT met 42703 — de
-- webhook returnt dan ingest_error. Draai deze migratie VÓÓR de code-deploy.
-- ============================================================================

BEGIN;

ALTER TABLE public.lisa_conversations
  ADD COLUMN IF NOT EXISTS unread_count integer NOT NULL DEFAULT 0
    CHECK (unread_count >= 0);

COMMENT ON COLUMN public.lisa_conversations.unread_count IS
  'BP3 (2026-09-02): aantal ongelezen inbound-berichten sinds laatste keer '
  'dat het gesprek werd geopend. Verhoogd door lisa-ghl-webhook.js + '
  'cron-lisa-conversations-poll.js bij elke direction=in insert. Gereset '
  'naar 0 door frontend via PATCH /api/lisa-conversations?id=<uuid> met '
  'body { unread_count: 0 }.';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- POST-CHECK
-- ═══════════════════════════════════════════════════════════════════════════
--
--   -- 1. Kolom bestaat + default gezet?
--   SELECT column_name, data_type, column_default, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='lisa_conversations'
--     AND column_name='unread_count';
--   -- Verwacht: integer, '0', NO.
--
--   -- 2. Bestaande rijen op 0?
--   SELECT count(*) FILTER (WHERE unread_count = 0) AS nul,
--          count(*) FILTER (WHERE unread_count > 0) AS gt_nul,
--          count(*) AS total
--   FROM public.lisa_conversations;
--   -- Verwacht: nul = total.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK (indien nodig)
-- ═══════════════════════════════════════════════════════════════════════════
--
--   BEGIN;
--     ALTER TABLE public.lisa_conversations DROP COLUMN IF EXISTS unread_count;
--   COMMIT;
-- ============================================================================
