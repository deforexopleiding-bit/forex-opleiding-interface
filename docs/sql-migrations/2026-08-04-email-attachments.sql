-- Migration: 2026-08-04 — email_messages.attachments jsonb + storage bucket
--
-- WAAROM
-- api/sync-emails.js parseerde tot nu toe wél parsed.attachments maar bewaarde
-- ze niet. Bijlagen (betaalbewijzen, contracten, screenshots) waren daardoor
-- alleen zichtbaar in Strato-webmail; niet in het CRM. Deze migratie voegt
-- de opslag-kolom toe. De helper api/_lib/email-attachment-upload.js schrijft
-- naar deze kolom vanuit sync-emails.js en backfill-email-attachments.js.
--
-- KOLOM-SHAPE
-- attachments = [
--   {
--     filename    : text,        -- original zoals afzender stuurde
--     mime_type   : text,        -- content-type
--     size_bytes  : integer,     -- na 10MB-filter (grotere skipped)
--     path        : text,        -- bucket-path (inbound/<mailbox>/<yyyy>/<mm>/<uid>-<idx>-<sha8>.<ext>)
--     public_url  : text,        -- getPublicUrl() resultaat
--     uploaded_at : text         -- ISO timestamp
--   }, ...
-- ]
-- NULL = nog niet verwerkt (oude rijen zonder backfill).
-- []   = expliciet 0 bijlagen (bericht heeft geen bijlagen — backfill of sync
--        heeft 'em gezien maar niks te uploaden).
--
-- STORAGE BUCKET
-- Naam: email-attachments (spiegel-patroon van whatsapp-media)
-- Public: JA (public_url wordt direct in de UI gebruikt; RLS-vervanging is
-- de moeilijk te raden path met sha8-suffix). Handmatig aan te maken in
-- Supabase Studio:
--   Storage → New bucket → naam: email-attachments → Public bucket: ON →
--   File size limit: 10 MB → Create.
-- Optioneel RLS-policy op storage.objects voor extra hardening:
--   CREATE POLICY "email-attachments read" ON storage.objects FOR SELECT
--     USING (bucket_id = 'email-attachments');
--
-- IDEMPOTENT
-- ADD COLUMN IF NOT EXISTS. GIN-index conditional op non-null (partial).

ALTER TABLE public.email_messages
  ADD COLUMN IF NOT EXISTS attachments jsonb;

-- Partial GIN-index — alleen rijen met bijlagen, zodat 'ie klein blijft
-- (~5% van de mails). Query-pattern: WHERE attachments IS NOT NULL en
-- bv. jsonb_array_length(attachments) > 0 voor "heeft bijlage"-filter.
CREATE INDEX IF NOT EXISTS idx_email_messages_attachments_gin
  ON public.email_messages USING gin (attachments)
  WHERE attachments IS NOT NULL;

COMMENT ON COLUMN public.email_messages.attachments IS
  'JSON-array van uploaded bijlagen. Shape: [{filename,mime_type,size_bytes,path,public_url,uploaded_at}]. NULL = nog niet verwerkt (backfill kandidaat). [] = geen bijlagen. Zie 2026-08-04-email-attachments.sql voor context.';
