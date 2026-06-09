-- ============================================================================
-- WhatsApp Templates Named Variables (Module C4)
-- Datum: 2026-06-09
-- Branch: feat/whatsapp-templates-c4-named-variables
--
-- Doel:
--   1) whatsapp_meta_templates.meta_param_mapping (jsonb):
--      Mapping van Meta-positionele placeholders ({{1}}, {{2}}, ...) naar
--      named variabele-keys (klant.naam, factuur.bedrag_open, ...) die
--      server-side worden geresolved bij send-time.
--      Backward-compat: NULL = legacy positionele template, caller levert
--      variables zelf aan (huidig gedrag van inbox-send-template.js).
--
--   2) invoices.payment_url (text) + payment_url_fetched_at (timestamptz):
--      Lazy cache voor TL public/payment URL. Wordt door een nieuw endpoint
--      api/finance-invoice-payment-link gevuld bij eerste lookup en
--      hergebruikt voor 24u. Route A uit finance-4-recon.md (lazy fetch +
--      cache) — vermijdt onnodige TL-info calls in cron.
--
-- Idempotent: BEGIN/COMMIT, ADD COLUMN IF NOT EXISTS. Veilig om opnieuw
-- te draaien.
--
-- ── Verifie-queries na uitvoeren ────────────────────────────────────────────
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'whatsapp_meta_templates'
--     AND column_name = 'meta_param_mapping';
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'invoices'
--     AND column_name IN ('payment_url','payment_url_fetched_at');
-- ============================================================================

BEGIN;

-- ── A. whatsapp_meta_templates.meta_param_mapping ──────────────────────────
ALTER TABLE public.whatsapp_meta_templates
  ADD COLUMN IF NOT EXISTS meta_param_mapping jsonb DEFAULT NULL;

COMMENT ON COLUMN public.whatsapp_meta_templates.meta_param_mapping IS
  'Mapping van Meta positionele placeholders naar named variable keys. Shape: { body: { "1": "klant.naam", "2": "factuur.bedrag_open" }, header_text: { "1": "klant.naam" }, buttons: [{ index: 0, url_params: { "1": "factuur.nummer" } }] }. NULL = legacy positioneel (caller levert variables zelf).';

-- ── B. invoices.payment_url + fetched_at (Route A: lazy cache) ─────────────
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS payment_url text,
  ADD COLUMN IF NOT EXISTS payment_url_fetched_at timestamptz;

COMMENT ON COLUMN public.invoices.payment_url IS
  'Lazy gecachte TL public-share / payment URL. NULL tot eerste resolve via /api/finance-invoice-payment-link. Re-fetch op cache-miss of >24h oud.';
COMMENT ON COLUMN public.invoices.payment_url_fetched_at IS
  'Tijdstip van laatste succesvolle TL fetch voor payment_url. Gebruikt als TTL-marker (24h staleness check).';

COMMIT;
