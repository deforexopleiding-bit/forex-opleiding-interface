-- Migratie: event_attendee_comms_log (FIX 4 — Optie C)
-- Datum: 16 juni 2026
--
-- Doel:
--   Centrale log-tabel voor alle uitgaande communicatie (e-mail + WhatsApp)
--   per event-attendee. Vervangt de huidige 3-bronnen-aanpak in
--   api/events-attendee-comms.js (event_automation_runs + run_log +
--   whatsapp_messages-join via customer_id) door één canonieke log.
--
-- Status van deze migratie:
--   Stap 1 — alleen SCHEMA + RLS aanmaken (deze SQL).
--   Stap 2 — codewijzigingen: nieuwe api/_lib/comms-log.js + insert-calls
--           in de 4 verzendpaden (invite-mail, invite-whatsapp,
--           automation-mail, automation-whatsapp). Geen reader-wijziging.
--   Stap 3 — (later) reader-switch in api/events-attendee-comms.js zodat
--           uitsluitend uit deze log gelezen wordt. Tot dan blijft de
--           bestaande 3-bronnen-aanpak werken zonder dat de log vereist
--           is — er kan dus geen blocker zijn als de log eens een keer
--           niet beschikbaar is.
--
-- Geen data-backfill: log start op go-live; oude history blijft leesbaar
-- via de huidige 3 bronnen.
--
-- VOORWAARDEN:
-- - ADMIN_ROLES helper has_any_role(text[]) bestaat (zelfde pattern als
--   follow_up_appointments / event_followups).
-- - event_attendees, events, event_automation_runs, auth.users bestaan.
--
-- IDEMPOTENT: gebruikt IF NOT EXISTS overal zodat re-runs niet stuk gaan.

BEGIN;

-- =============================================================================
-- 1. event_attendee_comms_log
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.event_attendee_comms_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attendee_id         uuid NOT NULL REFERENCES public.event_attendees(id) ON DELETE CASCADE,
  event_id            uuid REFERENCES public.events(id) ON DELETE CASCADE,
  channel             text NOT NULL CHECK (channel IN ('email','whatsapp')),
  direction           text NOT NULL DEFAULT 'outbound'
                        CHECK (direction IN ('inbound','outbound')),
  status              text NOT NULL
                        CHECK (status IN ('sent','failed','queued','skipped')),
  template_name       text,
  subject             text,
  sent_by_user_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  automation_run_id   uuid REFERENCES public.event_automation_runs(id) ON DELETE SET NULL,
  step_index          integer,
  meta_wamid          text,
  message_id          text,
  failure_reason      text,
  sent_at             timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.event_attendee_comms_log IS
  'Centrale log voor uitgaande mail/WhatsApp per attendee. Bron-of-truth voor api/events-attendee-comms (FIX 4 reader-switch komt in latere PR).';
COMMENT ON COLUMN public.event_attendee_comms_log.sent_by_user_id IS
  'NULL = automation-driven (events-automation-engine zet sentByUserId=null).';
COMMENT ON COLUMN public.event_attendee_comms_log.automation_run_id IS
  'NULL = manuele invite vanuit operator-UI; set bij automation-runs.';
COMMENT ON COLUMN public.event_attendee_comms_log.meta_wamid IS
  'WhatsApp Cloud API message-id. Bron-of-truth voor delivery-status updates.';
COMMENT ON COLUMN public.event_attendee_comms_log.message_id IS
  'Nodemailer/SMTP messageId voor e-mail.';

-- Indexen — lezen-paden: per attendee (timeline), per event (rapportage),
-- per wamid (delivery-status updates), per automation-run (debug).
CREATE INDEX IF NOT EXISTS idx_event_attendee_comms_log_attendee
  ON public.event_attendee_comms_log (attendee_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_event_attendee_comms_log_event
  ON public.event_attendee_comms_log (event_id);

CREATE INDEX IF NOT EXISTS idx_event_attendee_comms_log_wamid
  ON public.event_attendee_comms_log (meta_wamid)
  WHERE meta_wamid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_event_attendee_comms_log_run
  ON public.event_attendee_comms_log (automation_run_id)
  WHERE automation_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_event_attendee_comms_log_status
  ON public.event_attendee_comms_log (status)
  WHERE status IN ('failed','queued');

-- =============================================================================
-- 2. RLS — consistent met event_followups
-- =============================================================================

ALTER TABLE public.event_attendee_comms_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sender own + ADMIN_ROLES all (SELECT)"
  ON public.event_attendee_comms_log;
CREATE POLICY "Sender own + ADMIN_ROLES all (SELECT)"
  ON public.event_attendee_comms_log
  FOR SELECT TO authenticated
  USING (
    sent_by_user_id = auth.uid()
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

DROP POLICY IF EXISTS "ADMIN_ROLES all (ALL)"
  ON public.event_attendee_comms_log;
CREATE POLICY "ADMIN_ROLES all (ALL)"
  ON public.event_attendee_comms_log
  FOR ALL TO authenticated
  USING (
    public.has_any_role(ARRAY['super_admin','admin','manager'])
  )
  WITH CHECK (
    public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

-- Note: inserts vanuit de send-paden gebruiken supabaseAdmin (server-role,
-- RLS bypass). Bovenstaande SELECT-policy bepaalt wie de log kan lezen via
-- de userClient (bv. vanuit api/events-attendee-comms na de reader-switch).

COMMIT;
