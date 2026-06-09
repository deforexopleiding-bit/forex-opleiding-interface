-- 2026-06-09-payment-arrangements-d1.sql
-- Betalingsregelingen (Payment Arrangements) D1 fundament.
--
-- Dit migratie-script introduceert het DB-fundament voor de
-- Betalingsregelingen-feature binnen Finance > Wanbetalers. Drie tabellen:
--
--   1. payment_arrangements          -- aangemaakte regelingen per klant
--                                       (uitstel, gespreide betaling,
--                                        pauze, kwijtschelding, etc.)
--   2. pending_actions               -- voorgestelde of in-behandeling
--                                       acties die wachten op approval
--                                       of automatische uitvoer (D3/D4).
--   3. arrangement_action_settings   -- per-type toggles voor auto-execute
--                                       gedrag (D4 — admin-instelbaar).
--
-- Architectuur-notes:
-- - Tabel-namen volgen finance-conventie (Engels): public.customers en
--   public.invoices zijn de bron (NIET 'klanten' / 'facturen').
-- - invoice_ids is een uuid[] array — een regeling kan meerdere facturen
--   bundelen (bv. uitstel op 3 openstaande facturen tegelijk). FK-integriteit
--   niet via array-FK, validatie gebeurt in API-laag (gangbaar pattern).
-- - details is jsonb met type-specifieke payload:
--     { new_due_date }                                voor uitstel
--     { parts: [{ due_date, amount }, ...] }          voor gespreide betaling
--     { pause_from, pause_until, reason }             voor pauze
--     { write_off_amount, reason }                    voor kwijtschelding
-- - RLS pattern: authenticated SELECT, write USING(false) — alleen
--   service-role via API kan schrijven (consistent met finance-pattern
--   uit 2026-05-30-finance-fase-1-fundament.sql).
-- - updated_at trigger pattern: kopie van whatsapp_conversations_touch_updated_at
--   uit 2026-06-07-whatsapp-inbox-foundation.sql (regel 51-59).

BEGIN;

-- ===========================================================================
-- 1. payment_arrangements
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.payment_arrangements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  invoice_ids     uuid[] NOT NULL DEFAULT '{}'::uuid[],
  type            text NOT NULL
                    CHECK (type IN ('uitstel','gespreid','pauze','kwijtschelding','overig')),
  status          text NOT NULL DEFAULT 'voorgesteld'
                    CHECK (status IN ('voorgesteld','goedgekeurd','afgewezen','actief','voltooid','geannuleerd')),
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposed_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at     timestamptz,
  rejected_at     timestamptz,
  reject_reason   text,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.payment_arrangements.invoice_ids IS
  'Array van invoice UUIDs (public.invoices.id) waar deze regeling op van toepassing is. FK-integriteit wordt op API-niveau gevalideerd.';
COMMENT ON COLUMN public.payment_arrangements.details IS
  'Type-specifieke payload, bv. { new_due_date } voor uitstel, { parts:[{due_date,amount}] } voor gespreid, { pause_from, pause_until, reason } voor pauze, { write_off_amount, reason } voor kwijtschelding.';
COMMENT ON COLUMN public.payment_arrangements.status IS
  'Workflow-status: voorgesteld -> goedgekeurd/afgewezen -> actief -> voltooid/geannuleerd.';

CREATE INDEX IF NOT EXISTS idx_payment_arrangements_customer
  ON public.payment_arrangements (customer_id);
CREATE INDEX IF NOT EXISTS idx_payment_arrangements_status
  ON public.payment_arrangements (status);
CREATE INDEX IF NOT EXISTS idx_payment_arrangements_created
  ON public.payment_arrangements (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_arrangements_type
  ON public.payment_arrangements (type);

CREATE OR REPLACE FUNCTION public.payment_arrangements_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_arrangements_touch ON public.payment_arrangements;
CREATE TRIGGER trg_payment_arrangements_touch
  BEFORE UPDATE ON public.payment_arrangements
  FOR EACH ROW EXECUTE FUNCTION public.payment_arrangements_touch_updated_at();

-- ===========================================================================
-- 2. pending_actions
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.pending_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     uuid REFERENCES public.customers(id) ON DELETE CASCADE,
  arrangement_id  uuid REFERENCES public.payment_arrangements(id) ON DELETE CASCADE,
  action_type     text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected','executed','failed','cancelled')),
  proposed_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at     timestamptz,
  executed_at     timestamptz,
  execution_result jsonb,
  reject_reason   text,
  scheduled_for   timestamptz,
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.pending_actions.action_type IS
  'Vrij-tekst type-discriminator (bv. arrangement.propose, arrangement.approve, dunning.pause, invoice.update_due_date) zodat nieuwe acties zonder migratie kunnen worden toegevoegd.';
COMMENT ON COLUMN public.pending_actions.payload IS
  'Type-specifieke payload voor uitvoering, bv. { new_due_date, parts, pause_from, pause_until, reason, write_off_amount }.';
COMMENT ON COLUMN public.pending_actions.status IS
  'Workflow-status: pending -> approved/rejected -> executed/failed/cancelled.';
COMMENT ON COLUMN public.pending_actions.execution_result IS
  'Vrije payload met resultaat van automatische / handmatige uitvoer (timestamps, gemuteerde id''s, error-text bij failed).';

CREATE INDEX IF NOT EXISTS idx_pending_actions_customer
  ON public.pending_actions (customer_id);
CREATE INDEX IF NOT EXISTS idx_pending_actions_arrangement
  ON public.pending_actions (arrangement_id);
CREATE INDEX IF NOT EXISTS idx_pending_actions_status
  ON public.pending_actions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pending_actions_action_type
  ON public.pending_actions (action_type);
CREATE INDEX IF NOT EXISTS idx_pending_actions_scheduled
  ON public.pending_actions (scheduled_for)
  WHERE scheduled_for IS NOT NULL;

CREATE OR REPLACE FUNCTION public.pending_actions_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pending_actions_touch ON public.pending_actions;
CREATE TRIGGER trg_pending_actions_touch
  BEFORE UPDATE ON public.pending_actions
  FOR EACH ROW EXECUTE FUNCTION public.pending_actions_touch_updated_at();

-- ===========================================================================
-- 3. arrangement_action_settings
-- ===========================================================================
-- Per action_type een rij met auto-execute gedrag. Wordt door admin
-- onderhouden (D4). Toggles bepalen of een voorstel direct mag worden
-- uitgevoerd zonder approval, en eventueel binnen welke grenzen.
CREATE TABLE IF NOT EXISTS public.arrangement_action_settings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type         text NOT NULL UNIQUE,
  auto_execute        boolean NOT NULL DEFAULT false,
  requires_approval   boolean NOT NULL DEFAULT true,
  max_amount          numeric(10,2),
  max_days            integer,
  notify_roles        text[] NOT NULL DEFAULT '{}'::text[],
  config              jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.arrangement_action_settings.action_type IS
  'Discriminator-key die matcht met pending_actions.action_type, bv. arrangement.uitstel of arrangement.kwijtschelding.';
COMMENT ON COLUMN public.arrangement_action_settings.auto_execute IS
  'Wanneer true: voorgestelde actie wordt direct uitgevoerd (binnen max_amount / max_days grenzen) zonder approval-stap (D4).';
COMMENT ON COLUMN public.arrangement_action_settings.max_amount IS
  'Optionele bovengrens (EUR) waaronder auto_execute mag plaatsvinden; NULL = geen limiet.';
COMMENT ON COLUMN public.arrangement_action_settings.max_days IS
  'Optionele bovengrens (kalenderdagen, bv. max uitstel-termijn) waaronder auto_execute mag plaatsvinden; NULL = geen limiet.';
COMMENT ON COLUMN public.arrangement_action_settings.config IS
  'Vrije jsonb voor type-specifieke extra configuratie (toekomstig).';

CREATE INDEX IF NOT EXISTS idx_arrangement_action_settings_type
  ON public.arrangement_action_settings (action_type);

CREATE OR REPLACE FUNCTION public.arrangement_action_settings_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_arrangement_action_settings_touch ON public.arrangement_action_settings;
CREATE TRIGGER trg_arrangement_action_settings_touch
  BEFORE UPDATE ON public.arrangement_action_settings
  FOR EACH ROW EXECUTE FUNCTION public.arrangement_action_settings_touch_updated_at();

-- ===========================================================================
-- RLS — authenticated SELECT, write USING(false)
-- ===========================================================================
-- Pattern consistent met 2026-05-30-finance-fase-1-fundament.sql:
-- alle SELECTs door authenticated users (UI is RBAC-gated op feature_key);
-- INSERT/UPDATE/DELETE alleen door service-role via API (supabaseAdmin).
ALTER TABLE public.payment_arrangements         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_actions              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arrangement_action_settings  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_arrangements_select ON public.payment_arrangements;
DROP POLICY IF EXISTS payment_arrangements_insert ON public.payment_arrangements;
DROP POLICY IF EXISTS payment_arrangements_update ON public.payment_arrangements;
DROP POLICY IF EXISTS payment_arrangements_delete ON public.payment_arrangements;
CREATE POLICY payment_arrangements_select ON public.payment_arrangements
  FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY payment_arrangements_insert ON public.payment_arrangements
  FOR INSERT WITH CHECK (false);
CREATE POLICY payment_arrangements_update ON public.payment_arrangements
  FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY payment_arrangements_delete ON public.payment_arrangements
  FOR DELETE USING (false);

DROP POLICY IF EXISTS pending_actions_select ON public.pending_actions;
DROP POLICY IF EXISTS pending_actions_insert ON public.pending_actions;
DROP POLICY IF EXISTS pending_actions_update ON public.pending_actions;
DROP POLICY IF EXISTS pending_actions_delete ON public.pending_actions;
CREATE POLICY pending_actions_select ON public.pending_actions
  FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY pending_actions_insert ON public.pending_actions
  FOR INSERT WITH CHECK (false);
CREATE POLICY pending_actions_update ON public.pending_actions
  FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY pending_actions_delete ON public.pending_actions
  FOR DELETE USING (false);

DROP POLICY IF EXISTS arrangement_action_settings_select ON public.arrangement_action_settings;
DROP POLICY IF EXISTS arrangement_action_settings_insert ON public.arrangement_action_settings;
DROP POLICY IF EXISTS arrangement_action_settings_update ON public.arrangement_action_settings;
DROP POLICY IF EXISTS arrangement_action_settings_delete ON public.arrangement_action_settings;
CREATE POLICY arrangement_action_settings_select ON public.arrangement_action_settings
  FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY arrangement_action_settings_insert ON public.arrangement_action_settings
  FOR INSERT WITH CHECK (false);
CREATE POLICY arrangement_action_settings_update ON public.arrangement_action_settings
  FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY arrangement_action_settings_delete ON public.arrangement_action_settings
  FOR DELETE USING (false);

COMMIT;

-- ============================================================================
-- ROLLBACK (handmatig — alleen binnen rollback-window gebruiken)
-- ============================================================================
-- BEGIN;
--   DROP TRIGGER IF EXISTS trg_arrangement_action_settings_touch ON public.arrangement_action_settings;
--   DROP TRIGGER IF EXISTS trg_pending_actions_touch              ON public.pending_actions;
--   DROP TRIGGER IF EXISTS trg_payment_arrangements_touch         ON public.payment_arrangements;
--   DROP FUNCTION IF EXISTS public.arrangement_action_settings_touch_updated_at();
--   DROP FUNCTION IF EXISTS public.pending_actions_touch_updated_at();
--   DROP FUNCTION IF EXISTS public.payment_arrangements_touch_updated_at();
--   DROP TABLE IF EXISTS public.arrangement_action_settings;
--   DROP TABLE IF EXISTS public.pending_actions;
--   DROP TABLE IF EXISTS public.payment_arrangements;
-- COMMIT;
