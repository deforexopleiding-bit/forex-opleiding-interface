-- ---------------------------------------------------------------------------
-- 2026-10-28 - Dagelijks Dagrapport (21:30 NL): instellingen, link-tabel, bucket
--
-- Hoort bij: api/cron-dagrapport.js, api/_lib/dagrapport-{data,pdf,verzend}.js,
-- api/r/[token].js, api/admin-dagrapport-template.js.
--
-- READ-ONLY rapportqueries; dit script maakt alleen de ondersteunende objecten.
-- Handmatig draaien in Supabase (SQL editor). Idempotent.
-- ---------------------------------------------------------------------------

BEGIN;

-- 1) Instellingen (operator kan aan/uit + nummer zonder deploy wijzigen) --------
INSERT INTO public.app_settings (key, value) VALUES
  ('dagrapport_whatsapp_enabled', 'true'::jsonb),
  ('dagrapport_email_enabled',    'true'::jsonb),
  ('dagrapport_recipient_msisdn', '"+31655270212"'::jsonb),
  ('dagrapport_wa_template',      '"dfo_dagrapport"'::jsonb),
  ('dagrapport_wa_taal',          '"nl"'::jsonb),
  ('dagrapport_base_url',         '"https://crm.deforexopleiding.nl"'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 2) Link-tabel: token -> opgeslagen PDF-pad ----------------------------------
-- De WhatsApp-knop wijst naar /r/<token>; de redirect-endpoint maakt op het
-- moment van klikken een verse signed URL voor dit pad. Zo blijft de knop de
-- volgende ochtend werken terwijl de PDF prive blijft.
CREATE TABLE IF NOT EXISTS public.dagrapport_links (
  token        text PRIMARY KEY,
  storage_path text NOT NULL,
  datum        date,
  aangemaakt   timestamptz NOT NULL DEFAULT now()
);

-- Alleen de service-role (app) leest/schrijft; RLS aan zonder policy sluit de
-- rest uit. De service-role-client bypasst RLS.
ALTER TABLE public.dagrapport_links ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.dagrapport_links IS
  'Dagrapport: token -> storage_path van de dagrapport-PDF (voor de WhatsApp-knop via /r/<token>).';

-- 3) Private storage-bucket voor de PDFs --------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('dagrapporten', 'dagrapporten', false)
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- ---------------------------------------------------------------------------
-- Opruimen (optioneel, los te draaien): oude PDFs + links na 90 dagen weg.
--   DELETE FROM public.dagrapport_links WHERE aangemaakt < now() - interval '90 days';
--   (en de bijbehorende storage-objecten via de Storage-UI of een cron.)
-- ---------------------------------------------------------------------------
