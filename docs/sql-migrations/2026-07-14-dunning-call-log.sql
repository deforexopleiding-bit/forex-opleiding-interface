-- ============================================================================
-- 2026-07-14 — dunning_call_log: per-poging belpogingen-log in wanbetaler-dossier
--
-- Nieuwe tabel voor het loggen van individuele belpogingen richting
-- wanbetalers vanuit het case-paneel (finance.html #caseSheet Bellen-kaart).
-- Wordt geschreven door api/dunning-call-log-create.js na de "Bel nu"-flow
-- (of los, wanneer sales handmatig een uitkomst noteert). Wordt gelezen door
-- api/dunning-call-log-list.js voor de log-render + 3-stap-tracker.
--
-- Uitkomsten:
--   no_answer / voicemail / callback / payment_promise / payment_plan /
--   refused / wrong_number / paid_during_call
--
-- Resolutie-outcomes zijn: payment_promise, payment_plan, paid_during_call.
-- Na 3 pogingen zonder resolutie triggert de UI de optionele "→ naar incasso"-
-- nudge (routeert niet automatisch).
--
-- Idempotent (IF NOT EXISTS); RLS aan met authenticated-read + service-role-
-- write policies (consistent met migratie 002 pattern).
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.dunning_call_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  invoice_id    uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  attempted_at  timestamptz NOT NULL DEFAULT now(),
  sip_line      text CHECK (sip_line IS NULL OR sip_line IN ('nl','be')),
  outcome       text NOT NULL CHECK (outcome IN (
                    'no_answer','voicemail','callback','payment_promise',
                    'payment_plan','refused','wrong_number','paid_during_call'
                 )),
  note          text,
  created_by    uuid REFERENCES auth.users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dunning_call_log_customer
  ON public.dunning_call_log (customer_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_dunning_call_log_invoice
  ON public.dunning_call_log (invoice_id) WHERE invoice_id IS NOT NULL;

-- Cadance-instellingen: aantal pogingen + tussenpoos.
-- Standaard 3 pogingen, tussenpoos 3 dagen. Overrijden via app_settings.
INSERT INTO public.app_settings (key, value)
VALUES ('dunning_call_cadence', jsonb_build_object('max_attempts', 3, 'interval_days', 3))
ON CONFLICT (key) DO NOTHING;

-- RLS aan; select voor authenticated, write voor service_role (endpoints
-- gebruiken supabaseAdmin en gate zelf via requirePermission).
ALTER TABLE public.dunning_call_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dunning_call_log_select ON public.dunning_call_log;
CREATE POLICY dunning_call_log_select ON public.dunning_call_log
  FOR SELECT USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS dunning_call_log_write ON public.dunning_call_log;
CREATE POLICY dunning_call_log_write ON public.dunning_call_log
  FOR ALL USING (false) WITH CHECK (false);

COMMIT;
