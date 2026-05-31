-- ============================================================================
-- Offertes: verstuur-tracking + TL webhook (deal.won) status-updates
-- Datum: 2026-05-31
-- Branch: feature/quotation-send-overview-webhook
--
-- TL Focus kent GEEN quotation.* webhook-events. Realtime "offerte getekend"
-- loopt daarom via het deal.won-event (de offerte hangt onder een TL-deal die
-- bij acceptatie naar 'won' verspringt).
-- ============================================================================

BEGIN;

-- ── A. deals — verstuur/accept/decline timestamps ───────────────────────────
ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS tl_quotation_email_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS tl_quotation_accepted_at   timestamptz,
  ADD COLUMN IF NOT EXISTS tl_quotation_declined_at   timestamptz;

-- Status-enum uitbreiden met TL-termen accepted/declined (signed behouden voor
-- backward compat met bestaande code).
ALTER TABLE public.deals
  DROP CONSTRAINT IF EXISTS deals_tl_quotation_status_check;
ALTER TABLE public.deals
  ADD CONSTRAINT deals_tl_quotation_status_check
  CHECK (tl_quotation_status IS NULL OR tl_quotation_status IN
    ('draft','sent','accepted','declined','expired','signed'));

-- ── B. teamleader_webhooks — geregistreerde webhooks bij TL ─────────────────
CREATE TABLE IF NOT EXISTS public.teamleader_webhooks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tl_webhook_id  text,
  event_type     text NOT NULL,
  url            text NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  registered_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tl_webhooks_event ON public.teamleader_webhooks (event_type);

-- ── C. teamleader_webhook_events — log inkomende events (debug + audit) ──────
CREATE TABLE IF NOT EXISTS public.teamleader_webhook_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type      text,
  tl_object_type  text,
  tl_object_id    text,
  payload_json    jsonb,
  signature_valid boolean,
  processed_at    timestamptz,
  error           text,
  received_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tl_webhook_events_received ON public.teamleader_webhook_events (received_at DESC);

-- ── D. teamleader_settings — generieke k-v config (default template, etc) ───
CREATE TABLE IF NOT EXISTS public.teamleader_settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── E. RLS — authenticated-read, service_role-write ─────────────────────────
DO $$
DECLARE
  t text;
  tabs text[] := ARRAY['teamleader_webhooks', 'teamleader_webhook_events', 'teamleader_settings'];
BEGIN
  FOREACH t IN ARRAY tabs LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_select ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_insert ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_update ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_delete ON public.%I', t, t);
    -- webhook_events bevat ruwe payloads; alleen service_role mag lezen.
    IF t = 'teamleader_webhook_events' THEN
      EXECUTE format('CREATE POLICY %I_select ON public.%I FOR SELECT USING (false)', t, t);
    ELSE
      EXECUTE format('CREATE POLICY %I_select ON public.%I FOR SELECT USING (auth.uid() IS NOT NULL)', t, t);
    END IF;
    EXECUTE format('CREATE POLICY %I_insert ON public.%I FOR INSERT WITH CHECK (false)', t, t);
    EXECUTE format('CREATE POLICY %I_update ON public.%I FOR UPDATE USING (false) WITH CHECK (false)', t, t);
    EXECUTE format('CREATE POLICY %I_delete ON public.%I FOR DELETE USING (false)', t, t);
  END LOOP;
END$$;

COMMIT;

-- ROLLBACK
-- BEGIN;
--   DROP TABLE IF EXISTS public.teamleader_settings;
--   DROP TABLE IF EXISTS public.teamleader_webhook_events;
--   DROP TABLE IF EXISTS public.teamleader_webhooks;
--   ALTER TABLE public.deals
--     DROP CONSTRAINT IF EXISTS deals_tl_quotation_status_check,
--     DROP COLUMN IF EXISTS tl_quotation_declined_at,
--     DROP COLUMN IF EXISTS tl_quotation_accepted_at,
--     DROP COLUMN IF EXISTS tl_quotation_email_sent_at;
--   ALTER TABLE public.deals ADD CONSTRAINT deals_tl_quotation_status_check
--     CHECK (tl_quotation_status IS NULL OR tl_quotation_status IN
--       ('draft','sent','signed','declined','expired'));
-- COMMIT;
