-- =============================================================================
-- F5.1 — Mentor-grootboek schema
--   * Event afronden: events.completed_at/by, event_attendees.attendance_status,
--     event_attendees.followup_reason, event_mentors.was_present
--   * event_expenses (uitgaven per event)
--   * mentor_payouts   (batch-uitbetalingen per maand)
--   * mentor_ledger_entries (bonus + uitgave per entry)
--   * RLS-policies + has_any_role() helper
--
-- LET OP — geldtype:
--   Finance gebruikt numeric voor bedragen (zie invoices.amount_total/paid).
--   Daarom hier numeric(12,2) i.p.v. integer cents — "match finance" volgens
--   de F5.1-spec. JS-callers gebruiken Number + Math.round(x*100)/100 voor
--   nette afronding (zelfde patroon als dunning-engine).
--
-- has_any_role() bestaat nog niet in deze DB (events-f1 gebruikte 'm niet);
-- we definieren 'm hier zodat de F5.1 RLS-policies hem kunnen aanroepen.
-- =============================================================================
BEGIN;

-- has_any_role(text[]) bestaat al in productie (richer: checkt user_roles EN profiles.role). Hier NIET (her)definiëren — de RLS-policies hieronder binden aan de bestaande functie.

-- ── events.completed_* ───────────────────────────────────────────────────────
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- ── event_attendees.attendance_status / followup_reason ──────────────────────
ALTER TABLE public.event_attendees
  ADD COLUMN IF NOT EXISTS attendance_status text,
  ADD COLUMN IF NOT EXISTS followup_reason text;
-- CHECK los (DROP+ADD voor idempotency)
ALTER TABLE public.event_attendees
  DROP CONSTRAINT IF EXISTS event_attendees_attendance_status_check;
ALTER TABLE public.event_attendees
  ADD CONSTRAINT event_attendees_attendance_status_check
  CHECK (attendance_status IS NULL OR attendance_status IN ('aanwezig','no_show','afgemeld'));

-- ── event_mentors.was_present ────────────────────────────────────────────────
ALTER TABLE public.event_mentors
  ADD COLUMN IF NOT EXISTS was_present boolean NOT NULL DEFAULT false;

-- ── event_expenses ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.event_expenses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  amount      numeric(12,2) NOT NULL CHECK (amount >= 0),
  vendor      text,
  spent_at    date,
  note        text,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_expenses_event ON public.event_expenses (event_id);

-- ── mentor_payouts ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mentor_payouts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mentor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  period_month   date NOT NULL,
  total          numeric(12,2) NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'open',
  created_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  paid_at        timestamptz
);
ALTER TABLE public.mentor_payouts
  DROP CONSTRAINT IF EXISTS mentor_payouts_status_check;
ALTER TABLE public.mentor_payouts
  ADD CONSTRAINT mentor_payouts_status_check
  CHECK (status IN ('open','uitbetaald'));
CREATE INDEX IF NOT EXISTS idx_mentor_payouts_mentor ON public.mentor_payouts (mentor_user_id);

-- ── mentor_ledger_entries ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mentor_ledger_entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mentor_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  team_member_id   uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  event_id         uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  entry_type       text NOT NULL,
  attendee_id      uuid REFERENCES public.event_attendees(id) ON DELETE SET NULL,
  customer_id      uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  basis            numeric(12,2),
  basis_incl_btw   boolean NOT NULL DEFAULT true,
  pct              numeric(5,2),
  amount           numeric(12,2) NOT NULL,
  status           text NOT NULL DEFAULT 'pending',
  source_invoice_id text,
  source_quote_id  text,
  payout_id        uuid REFERENCES public.mentor_payouts(id) ON DELETE SET NULL,
  idempotency_key  text UNIQUE,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  released_at      timestamptz,
  paid_at          timestamptz
);
ALTER TABLE public.mentor_ledger_entries
  DROP CONSTRAINT IF EXISTS mentor_ledger_entries_entry_type_check;
ALTER TABLE public.mentor_ledger_entries
  ADD CONSTRAINT mentor_ledger_entries_entry_type_check
  CHECK (entry_type IN ('bonus','uitgave'));
ALTER TABLE public.mentor_ledger_entries
  DROP CONSTRAINT IF EXISTS mentor_ledger_entries_status_check;
ALTER TABLE public.mentor_ledger_entries
  ADD CONSTRAINT mentor_ledger_entries_status_check
  CHECK (status IN ('pending','wachten_op_betaling','vrijgegeven','geannuleerd','uitbetaald'));
CREATE INDEX IF NOT EXISTS idx_ledger_mentor ON public.mentor_ledger_entries (mentor_user_id);
CREATE INDEX IF NOT EXISTS idx_ledger_event  ON public.mentor_ledger_entries (event_id);
CREATE INDEX IF NOT EXISTS idx_ledger_status ON public.mentor_ledger_entries (status);
ALTER TABLE public.mentor_ledger_entries
  ADD COLUMN IF NOT EXISTS basis_incl_btw boolean NOT NULL DEFAULT true;

-- ── RLS — alleen SELECT-policies; schrijven gaat via service-role endpoints ──
ALTER TABLE public.event_expenses        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mentor_payouts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mentor_ledger_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ledger_select   ON public.mentor_ledger_entries;
CREATE POLICY ledger_select ON public.mentor_ledger_entries FOR SELECT
  USING (
    public.has_any_role(ARRAY['super_admin','admin','manager'])
    OR mentor_user_id = auth.uid()
  );

DROP POLICY IF EXISTS payouts_select  ON public.mentor_payouts;
CREATE POLICY payouts_select ON public.mentor_payouts FOR SELECT
  USING (
    public.has_any_role(ARRAY['super_admin','admin','manager'])
    OR mentor_user_id = auth.uid()
  );

DROP POLICY IF EXISTS expenses_select ON public.event_expenses;
CREATE POLICY expenses_select ON public.event_expenses FOR SELECT
  USING (
    public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

COMMIT;
