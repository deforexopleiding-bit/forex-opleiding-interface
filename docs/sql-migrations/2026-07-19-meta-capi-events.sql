-- 2026-07-19 — Meta Conversions API events log (fase 6)
--
-- Doel: idempotentie-anker voor het server-side terugsturen van "klant
-- geworden"-events naar Meta CAPI. Elke deal krijgt maximaal 1 CAPI-event
-- (UNIQUE deal_id). De deals-tabel wordt NIET gemuteerd.
--
-- Event-naam: 'CRMCustomer' (bewust géén Lead/Purchase — die draaien al
-- server-side via het bureau). Custom conversion op deze naam in Meta
-- Events Manager gebruiken om op te optimaliseren.
--
-- Value = deals.total_amount (bruto contractwaarde). Currency altijd 'EUR'.
-- event_id = 'crm_customer_<deal.id>' (deterministic) → Meta dedupt binnen
-- 7-dagen-window bij retry.
--
-- match_keys: bevat ALLEEN presence-booleans (bv. {em:true, ph:false,
-- fbc:true, fbp:true, client_ip:false, client_ua:true}). Géén PII —
-- alleen om achteraf te kunnen zien wélke sleutels beschikbaar waren.
--
-- STATUS-CHECK: 'sent' | 'failed' | 'skipped'. skipped = geen bruikbare
-- match-key (geen em/ph/fbc); 'failed' = Meta gaf non-2xx; 'sent' = OK.
--
-- ⚠ MIGRATIE NIET BLOKKEREND: cron-meta-capi is defensief (isMissingRelation
-- → skip+warn). Zonder migratie draait de cron gewoon door zonder writes.

BEGIN;

CREATE TABLE IF NOT EXISTS public.meta_capi_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id       uuid NOT NULL UNIQUE REFERENCES public.deals(id) ON DELETE CASCADE,
  event_name    text NOT NULL,
  event_id      text NOT NULL,
  status        text NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  value         numeric(14,4),
  currency      text,
  match_keys    jsonb,
  meta_response jsonb,
  skip_reason   text,
  test_mode     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.meta_capi_events IS
  'Meta Conversions API event-log (fase 6). Unique(deal_id) = idempotentie: 1 CAPI-event per deal, ooit. '
  'Zie migratie 2026-07-19-meta-capi-events.sql + api/cron-meta-capi.js.';
COMMENT ON COLUMN public.meta_capi_events.match_keys IS
  'Presence-booleans (bv. {em:true,ph:false,fbc:true}). GEEN PII — alleen welke sleutels beschikbaar waren.';
COMMENT ON COLUMN public.meta_capi_events.event_id IS
  'Deterministic: crm_customer_<deal.id>. Meta dedupt op (event_name, event_id) in 7-dagen-window.';

CREATE INDEX IF NOT EXISTS idx_meta_capi_events_status  ON public.meta_capi_events (status);
CREATE INDEX IF NOT EXISTS idx_meta_capi_events_created ON public.meta_capi_events (created_at DESC);

COMMIT;

-- PostgREST schema-cache reload (les uit #814/#820).
NOTIFY pgrst, 'reload schema';

-- Sanity-check: tabel bestaat + rij-count (0 bij eerste run).
SELECT
  table_name,
  count(*) FILTER (WHERE column_name IN ('deal_id','event_name','event_id','status','value','currency','match_keys','meta_response','skip_reason','test_mode')) AS kern_kolommen
FROM information_schema.columns
WHERE table_name = 'meta_capi_events'
GROUP BY table_name;

SELECT count(*) AS rij_aantal FROM public.meta_capi_events;
