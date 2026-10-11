-- 2026-10-11 · Mailbouwer — blokstructuur bij sjablonen/campagnes + bucket voor afbeeldingen.
--
--   lead_mail_sjablonen.blokken  jsonb  — de blokken (om later te bewerken); de
--                                         kolom html blijft de gecompileerde mail.
--   massa_campagnes.blokken      jsonb  — massa met een bouwer-mail: de wachtrij
--                                         compileert per ontvanger opnieuw uit de JSON.
--   bucket mail-afbeeldingen     PUBLIEK lezen (mailclients halen de afbeelding op
--                                via een absolute https-URL), 2 MB, alleen
--                                PNG/JPEG/GIF/WebP. Uploaden ALLEEN via
--                                api/mail-afbeelding-upload.js (service role, na
--                                login + recht) — daarom bewust GEEN insert-/update-/
--                                delete-policy voor anon of authenticated.
--
-- Bestaande sjablonen zonder blokken blijven werken (vallen terug op html).
-- BLOKKEREND voor de mailbouwer (opslaan met blokken, afbeelding uploaden);
-- NIET blokkerend voor gewone mails en losse sjablonen.
-- Supabase SQL-editor: losse statements, geen DO-blokken.

-- ── 1. Blokken-kolommen ──────────────────────────────────────────────────────
ALTER TABLE public.lead_mail_sjablonen ADD COLUMN IF NOT EXISTS blokken jsonb;
ALTER TABLE public.massa_campagnes ADD COLUMN IF NOT EXISTS blokken jsonb;

-- ── 2. Bucket voor mail-afbeeldingen (publiek lezen) ─────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'mail-afbeeldingen',
  'mail-afbeeldingen',
  true,                                                -- publiek: mailclients moeten hem kunnen ophalen
  2097152,                                             -- 2 MB per bestand
  ARRAY['image/png', 'image/jpeg', 'image/gif', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- ── 3. Controle (alleen lezen) ───────────────────────────────────────────────
-- SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'mail-afbeeldingen';
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name IN ('lead_mail_sjablonen', 'massa_campagnes') AND column_name = 'blokken';  -- 2 rijen
-- SELECT policyname FROM pg_policies WHERE tablename = 'objects' AND qual::text LIKE '%mail-afbeeldingen%';  -- 0 rijen

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- ALTER TABLE public.lead_mail_sjablonen DROP COLUMN IF EXISTS blokken;
-- ALTER TABLE public.massa_campagnes DROP COLUMN IF EXISTS blokken;
-- (bucket alleen verwijderen als hij leeg is: DELETE FROM storage.buckets WHERE id = 'mail-afbeeldingen';)
