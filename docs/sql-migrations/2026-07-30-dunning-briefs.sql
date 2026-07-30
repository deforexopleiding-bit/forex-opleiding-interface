-- 2026-07-30 — dunning_briefs: persistent bewijs van verstuurde WIK-brieven (fase 6)
--
-- JURIDISCHE EIS: elke verstuurde WIK-14-dagenbrief (NL) / eerste (kosteloze)
-- herinnering (BE) moet als BEWAARDE PDF terugvindbaar zijn. Zonder de exact-
-- verstuurde PDF is er geen bewijs — hergenereren volstaat niet want:
--   • Templates kunnen zijn gewijzigd sinds verzending
--   • Klant-adres kan zijn bijgewerkt
--   • Bedragen kunnen kloppen ≠ wat destijds op de brief stond
--
-- ADDITIEF: nieuwe tabel + RLS-policy. Bestaande incasso_pre_brief_sent log
-- (in dunning_log) blijft; we voegen brief_id + pdf_path toe aan de payload
-- via de generator-wijziging in api/incasso-pre-brief.js.
--
-- Volgorde:
--   1. Maak eerst de Supabase Storage bucket 'dunning-briefs' aan in het
--      dashboard (Storage > Create new bucket):
--         - Name: dunning-briefs
--         - Public bucket: OFF (private — access via signed URLs)
--         - File size limit: 10 MB (WIK-brieven zijn ~30-60 KB, ruime marge)
--         - Allowed MIME types: application/pdf
--   2. Draai deze SQL-migratie (tabel + indexes + RLS).
--   3. Deploy code (incasso-pre-brief.js update + nieuwe endpoints).
--   4. Vanaf nu wordt elke nieuwe WIK-brief opgeslagen.
--
-- Bestaande brieven vóór deze migratie zijn NIET automatisch backfillbaar
-- (de originele PDF's zijn niet bewaard). Voor die klanten: nieuwe brief
-- genereren als bewijs nodig is, of dunning_log-entry als indirect bewijs.

CREATE TABLE IF NOT EXISTS public.dunning_briefs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id           uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  invoice_id            uuid NULL REFERENCES public.invoices(id) ON DELETE SET NULL,
  template_code         text NOT NULL,          -- 'incasso_pre_nl' | 'incasso_pre_be'
  country               text NOT NULL CHECK (country IN ('NL','BE')),
  pdf_path              text NOT NULL,          -- storage path: '{customer_id}/{timestamp}-{shortId}.pdf'
  pdf_size_bytes        int NULL,
  generated_at          timestamptz NOT NULL DEFAULT now(),
  generated_by_user_id  uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  sent_via              text NULL CHECK (sent_via IN ('post','email')),   -- NULL = alleen download (nog niet verstuurd)
  sent_at               timestamptz NULL,
  sent_to_email         text NULL,              -- alleen bij sent_via='email' — verstuurd naar dit adres
  sent_by_user_id       uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  send_error            text NULL,              -- laatste mail-poging fout (fail-loud in UI)
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dunning_briefs_customer_id
  ON public.dunning_briefs (customer_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_dunning_briefs_sent_via
  ON public.dunning_briefs (sent_via, sent_at DESC)
  WHERE sent_via IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dunning_briefs_invoice_id
  ON public.dunning_briefs (invoice_id)
  WHERE invoice_id IS NOT NULL;

-- updated_at auto-touch via trigger (consistent met andere fin-tabellen).
CREATE OR REPLACE FUNCTION public.trg_dunning_briefs_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS dunning_briefs_touch_updated_at ON public.dunning_briefs;
CREATE TRIGGER dunning_briefs_touch_updated_at
  BEFORE UPDATE ON public.dunning_briefs
  FOR EACH ROW EXECUTE FUNCTION public.trg_dunning_briefs_touch_updated_at();

-- RLS: alleen server-side supabaseAdmin schrijft/leest deze tabel (via de
-- endpoints). Frontend leest via endpoint (RBAC finance.incasso.manage /
-- finance.dunning.view). Geen directe user-access.
ALTER TABLE public.dunning_briefs ENABLE ROW LEVEL SECURITY;

-- Geen policies gedefinieerd → default DENY voor authenticated users.
-- supabaseAdmin (service_role) bypasst RLS zoals gebruikelijk.

COMMENT ON TABLE public.dunning_briefs IS
  'Persistent bewijs van verstuurde WIK-14-dagenbrieven (NL) en eerste
   herinneringen (BE). Elke rij verwijst naar de bewaarde PDF in de
   dunning-briefs storage-bucket. Vereist voor juridisch bewijs bij
   incasso-overdracht — hergenereren volstaat niet.';
COMMENT ON COLUMN public.dunning_briefs.pdf_path IS
  'Storage-path binnen de dunning-briefs bucket. Ophalen via
   supabaseAdmin.storage.from(''dunning-briefs'').createSignedUrl(path, ttl).';
COMMENT ON COLUMN public.dunning_briefs.sent_via IS
  'NULL = alleen gegenereerd/gedownload; ''post'' = handmatig gemarkeerd
   verstuurd per post; ''email'' = via Strato SMTP verstuurd (bijlage).';
