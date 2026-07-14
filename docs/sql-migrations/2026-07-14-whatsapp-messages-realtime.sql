-- ============================================================================
-- 2026-07-14 — whatsapp_messages in supabase_realtime publication
--
-- Voegt de tabel whatsapp_messages toe aan de default supabase_realtime
-- publication zodat authenticated frontends INSERT-events kunnen ontvangen
-- via .channel().on('postgres_changes', ...).
--
-- Gebruikt door de wanbetalers-inbox (modules/finance.html
-- _startInboxRealtime) om berichten instant zichtbaar te maken zonder
-- afhankelijk te zijn van de 6s-poll.
--
-- RLS BLIJFT ONGEWIJZIGD: de bestaande policy wa_msg_select (SELECT USING
-- auth.uid() IS NOT NULL, aangemaakt in 2026-06-07-whatsapp-inbox-
-- foundation.sql regel 104) filtert al op ingelogde users. Realtime
-- respecteert die policy en levert alleen berichten aan gebruikers die
-- SELECT-rechten hebben. Geen verbreding nodig.
--
-- Idempotent via DO-block met check op pg_publication_tables.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname   = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename  = 'whatsapp_messages'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.whatsapp_messages';
  END IF;
END $$;

COMMIT;
