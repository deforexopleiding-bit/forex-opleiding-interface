-- ============================================================================
-- Finance Fase 3 — CAMT ↔ TL invoice matching engine
-- Datum: 2026-06-06
-- Branch: feat/finance-3-camt-payment-matcher
--
-- Twee tabellen:
-- 1. payment_match_candidates: voor elke (camt_transaction, invoice)-paar
--    waarvoor scoring opleverde dat ze mogelijk bij elkaar horen.
-- 2. app_settings: key/value voor app-brede instellingen (autopilot toggle +
--    threshold). Nieuwe tabel — voor cross-fase hergebruik.
--
-- Idempotent (CREATE IF NOT EXISTS + ON CONFLICT DO NOTHING).
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.payment_match_candidates (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  camt_transaction_id      uuid NOT NULL REFERENCES public.camt_transactions(id) ON DELETE CASCADE,
  invoice_id               uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  match_score              int NOT NULL,                                -- 0-100
  match_reasons            text[] NOT NULL DEFAULT '{}',                -- bv. ['exact_amount','invoice_number_in_description']
  status                   text NOT NULL DEFAULT 'suggested'
                             CHECK (status IN ('suggested', 'confirmed', 'rejected', 'auto_confirmed')),
  confirmed_by_user_id     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  confirmed_at             timestamptz,
  registered_payment_id    uuid REFERENCES public.payments(id) ON DELETE SET NULL,
  rejected_reason          text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_camt_invoice_match
  ON public.payment_match_candidates (camt_transaction_id, invoice_id);
CREATE INDEX IF NOT EXISTS idx_match_candidates_status_score
  ON public.payment_match_candidates (status, match_score DESC);
CREATE INDEX IF NOT EXISTS idx_match_candidates_camt_tx
  ON public.payment_match_candidates (camt_transaction_id);
CREATE INDEX IF NOT EXISTS idx_match_candidates_invoice
  ON public.payment_match_candidates (invoice_id);

CREATE OR REPLACE FUNCTION public.payment_match_candidates_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_match_candidates_touch ON public.payment_match_candidates;
CREATE TRIGGER trg_match_candidates_touch
  BEFORE UPDATE ON public.payment_match_candidates
  FOR EACH ROW EXECUTE FUNCTION public.payment_match_candidates_touch_updated_at();

ALTER TABLE public.payment_match_candidates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pmc_select ON public.payment_match_candidates;
DROP POLICY IF EXISTS pmc_write  ON public.payment_match_candidates;
CREATE POLICY pmc_select ON public.payment_match_candidates FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY pmc_write  ON public.payment_match_candidates FOR ALL USING (false) WITH CHECK (false);

-- ── app_settings (nieuw) ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.app_settings (
  key                 text PRIMARY KEY,
  value               jsonb NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id  uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS app_settings_select ON public.app_settings;
DROP POLICY IF EXISTS app_settings_write  ON public.app_settings;
CREATE POLICY app_settings_select ON public.app_settings FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY app_settings_write  ON public.app_settings FOR ALL USING (false) WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.app_settings_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_app_settings_touch ON public.app_settings;
CREATE TRIGGER trg_app_settings_touch
  BEFORE UPDATE ON public.app_settings
  FOR EACH ROW EXECUTE FUNCTION public.app_settings_touch_updated_at();

-- Seed autopilot-setting. Default uit, drempel 95.
INSERT INTO public.app_settings (key, value) VALUES
  ('payment_match_autopilot', '{"enabled": false, "threshold": 95}'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- ============================================================================
-- Verificatie:
--   SELECT count(*) FROM payment_match_candidates;          -- 0 direct na migratie
--   SELECT key, value FROM app_settings;                    -- 1 rij autopilot
-- ============================================================================
