-- Event follow-ups (PR Z) — afronden-beoordeling herzien
-- Datum: 15 juni 2026
-- Doel:
--   1. event_attendees.outcome (text) — uitkomst per aanwezige deelnemer
--      (opvolgen | geen_interesse | nog_onbekend). 'sale' wordt afgeleid
--      uit getekende offerte (geen handmatige optie).
--   2. event_followups: aparte tabel met open + afgehandelde follow-up-rijen
--      die ontstaan vanuit het afronden van een event.
--   3. Partial unique index op (attendee_id) WHERE status='open' →
--      idempotent UPSERT-doel zodat her-afronden geen duplicaten oplevert.
--
-- VOORWAARDEN:
-- - ADMIN_ROLES helper has_any_role(text[]) bestaat (zelfde pattern als
--   follow_up_appointments).
-- - event_attendees + events tabellen bestaan (RLS al actief).
--
-- IDEMPOTENT: gebruikt IF NOT EXISTS overal zodat re-runs niet stuk gaan.

BEGIN;

-- =============================================================================
-- 1. event_attendees.outcome
-- =============================================================================

ALTER TABLE public.event_attendees
  ADD COLUMN IF NOT EXISTS outcome text
    CHECK (outcome IN ('opvolgen','geen_interesse','nog_onbekend'));

COMMENT ON COLUMN public.event_attendees.outcome IS
  'Uitkomst-beoordeling bij afronden (alleen voor attendance_status=aanwezig).
   Sale wordt afgeleid uit gekoppelde getekende offerte, geen handmatige waarde.';

-- =============================================================================
-- 2. event_followups
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.event_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attendee_id uuid REFERENCES public.event_attendees(id) ON DELETE CASCADE,
  event_id uuid REFERENCES public.events(id) ON DELETE CASCADE,
  reason text,
  follow_up_date date,
  owner_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','afgehandeld')),
  note text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  handled_at timestamptz,
  handled_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Idempotency-target voor UPSERT vanuit events-complete:
-- exact 1 open follow-up per deelnemer.
CREATE UNIQUE INDEX IF NOT EXISTS event_followups_one_open_per_attendee
  ON public.event_followups (attendee_id)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_event_followups_event ON public.event_followups(event_id);
CREATE INDEX IF NOT EXISTS idx_event_followups_owner ON public.event_followups(owner_id);
CREATE INDEX IF NOT EXISTS idx_event_followups_status ON public.event_followups(status);
CREATE INDEX IF NOT EXISTS idx_event_followups_followup_date ON public.event_followups(follow_up_date) WHERE status = 'open';

-- =============================================================================
-- 3. RLS — consistent met follow_up_appointments
-- =============================================================================

ALTER TABLE public.event_followups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owner own + ADMIN_ROLES all (SELECT)" ON public.event_followups;
CREATE POLICY "Owner own + ADMIN_ROLES all (SELECT)"
  ON public.event_followups
  FOR SELECT TO authenticated
  USING (
    owner_id = auth.uid()
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

DROP POLICY IF EXISTS "Owner own + ADMIN_ROLES all (ALL)" ON public.event_followups;
CREATE POLICY "Owner own + ADMIN_ROLES all (ALL)"
  ON public.event_followups
  FOR ALL TO authenticated
  USING (
    owner_id = auth.uid()
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  )
  WITH CHECK (
    owner_id = auth.uid()
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

COMMIT;
