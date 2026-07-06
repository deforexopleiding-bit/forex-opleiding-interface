-- =============================================================================
-- 2026-07-06 — Contante mentor-trajects (bouwstap 1/2)
--
-- Nieuwe tabel mentor_cash_trajects: trajects waarbij de klant CONTANT betaalt
-- en de mentor per maand een deel van z'n bonus vrij ziet vallen zonder
-- factuurcheck. Vrijval-motor is api/cron-mentor-cash-release.js (maandelijkse
-- cron), insert-target blijft mentor_ledger_entries (entry_type='bonus',
-- status='vrijgegeven') zodat het meeloopt in payout-run + bonus-overview.
--
-- pct + bonus_total worden bij aanmaken gesnapshot (constante 3% wijzigen mag
-- lopende trajects niet retroactief raken). Idempotency van de cron gaat via
-- mentor_ledger_entries.idempotency_key = 'cashtraject:<id>:term:<n>'.
--
-- Volgt patroon uit 2026-06-15-f5-1-mentor-grootboek.sql:
-- SELECT-policy via has_any_role() voor manager+ + mentor-eigen zicht; alle
-- schrijfacties via service-role endpoints (mentor.ledger.write).
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.mentor_cash_trajects (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mentor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  event_id       uuid NOT NULL REFERENCES public.events(id) ON DELETE RESTRICT,
  customer_id    uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  client_label   text NOT NULL,
  total_amount   numeric(12,2) NOT NULL CHECK (total_amount >= 0),
  term_count     int NOT NULL CHECK (term_count >= 1),
  pct            numeric(5,2) NOT NULL,   -- snapshot van bonus-% bij aanmaak
  bonus_total    numeric(12,2) NOT NULL,  -- round(total_amount * pct/100, 2)
  start_month    date NOT NULL,           -- 1e van de startmaand (YYYY-MM-01)
  status         text NOT NULL DEFAULT 'active',
  paused_at      timestamptz,
  created_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  note           text
);

-- Idempotente CHECKs (DROP+ADD zodat 'ie bij re-run niet dubbel gedefinieerd wordt).
ALTER TABLE public.mentor_cash_trajects
  DROP CONSTRAINT IF EXISTS mentor_cash_trajects_status_check;
ALTER TABLE public.mentor_cash_trajects
  ADD CONSTRAINT mentor_cash_trajects_status_check
  CHECK (status IN ('active','paused','completed'));

CREATE INDEX IF NOT EXISTS idx_cash_trajects_mentor ON public.mentor_cash_trajects (mentor_user_id);
CREATE INDEX IF NOT EXISTS idx_cash_trajects_event  ON public.mentor_cash_trajects (event_id);
CREATE INDEX IF NOT EXISTS idx_cash_trajects_status ON public.mentor_cash_trajects (status);

-- RLS — alleen SELECT-policy (schrijven via service-role endpoints; mentor.ledger.write).
ALTER TABLE public.mentor_cash_trajects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cash_trajects_select ON public.mentor_cash_trajects;
CREATE POLICY cash_trajects_select ON public.mentor_cash_trajects FOR SELECT
  USING (
    public.has_any_role(ARRAY['super_admin','admin','manager'])
    OR mentor_user_id = auth.uid()
  );

COMMENT ON TABLE  public.mentor_cash_trajects IS
  'Contante trajects — per-maand bonusvrijval zonder factuurcheck; vrijgevallen bonussen komen in mentor_ledger_entries.';
COMMENT ON COLUMN public.mentor_cash_trajects.pct IS
  'Snapshot van bonus-% bij aanmaak — voorkomt dat wijzigen van de default-% lopende trajects retroactief raakt.';
COMMENT ON COLUMN public.mentor_cash_trajects.bonus_total IS
  'Totale mentor-bonus over dit traject (= round(total_amount * pct/100, 2)). Cron verdeelt over term_count termijnen.';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ROLLBACK
-- DROP TABLE public.mentor_cash_trajects;
