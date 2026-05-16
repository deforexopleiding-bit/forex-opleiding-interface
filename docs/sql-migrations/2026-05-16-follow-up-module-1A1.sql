-- Follow-up Module — Fase 1A.1 migratie
-- Datum: 16 mei 2026
-- Doel: 7 tabellen + RLS-policies + indexes + storage bucket
--
-- VOORWAARDEN:
-- - ADMIN_ROLES helpers bestaan: has_any_role(text[]), is_super_admin()
-- - profiles tabel heeft alle 7 rollen in CHECK-constraint
-- - Geen bestaande follow_up_* tabellen
--
-- Bij twijfel: voer eerst de rollback-SQL uit om schone state te garanderen.

BEGIN;

-- =============================================================================
-- 1. follow_up_appointments
-- =============================================================================

CREATE TABLE public.follow_up_appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ghl_appointment_id text UNIQUE NOT NULL,
  zoom_meeting_id text,
  lead_name text NOT NULL,
  lead_email text,
  lead_phone text,
  lead_ghl_contact_id text NOT NULL,
  scheduled_at timestamptz NOT NULL,
  duration_minutes integer NOT NULL DEFAULT 30,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','in_progress','completed','no_show','cancelled')),
  voicememo_status text NOT NULL DEFAULT 'pending'
    CHECK (voicememo_status IN ('pending','sent','skipped')),
  voicememo_sent_at timestamptz,
  voicememo_sent_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  requires_screenshot boolean NOT NULL DEFAULT false,
  screenshot_url text,
  screenshot_uploaded_at timestamptz,
  snelle_notitie text,
  owner_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_fu_appointments_ghl_id ON public.follow_up_appointments(ghl_appointment_id);
CREATE INDEX idx_fu_appointments_zoom_id ON public.follow_up_appointments(zoom_meeting_id) WHERE zoom_meeting_id IS NOT NULL;
CREATE INDEX idx_fu_appointments_lead_contact ON public.follow_up_appointments(lead_ghl_contact_id);
CREATE INDEX idx_fu_appointments_owner ON public.follow_up_appointments(owner_id);
CREATE INDEX idx_fu_appointments_scheduled ON public.follow_up_appointments(scheduled_at);
CREATE INDEX idx_fu_appointments_status ON public.follow_up_appointments(status);

ALTER TABLE public.follow_up_appointments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Sales own + ADMIN_ROLES all (SELECT)"
  ON public.follow_up_appointments
  FOR SELECT TO authenticated
  USING (
    owner_id = auth.uid()
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

CREATE POLICY "Sales own + ADMIN_ROLES all (ALL)"
  ON public.follow_up_appointments
  FOR ALL TO authenticated
  USING (
    owner_id = auth.uid()
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  )
  WITH CHECK (
    owner_id = auth.uid()
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

-- =============================================================================
-- 2. follow_up_outcomes
-- =============================================================================

CREATE TABLE public.follow_up_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES public.follow_up_appointments(id) ON DELETE CASCADE,
  outcome text NOT NULL
    CHECK (outcome IN ('klant_geworden','geen_klant','no_show')),
  bezwaren text[],
  volgende_actie text
    CHECK (volgende_actie IN ('bellen','email','event','sluiten','niet_meer_opvolgen') OR volgende_actie IS NULL),
  terugkom_datum date,
  warmte_score integer CHECK (warmte_score IS NULL OR (warmte_score >= 1 AND warmte_score <= 10)),
  notitie text,
  opvolging_status text
    CHECK (opvolging_status IN ('gepland','geregeld','verzet','vervallen') OR opvolging_status IS NULL),
  opvolging_geregeld_at timestamptz,
  niet_meer_opvolgen boolean NOT NULL DEFAULT false,
  ingevuld_door uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ingevuld_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_fu_outcomes_appointment ON public.follow_up_outcomes(appointment_id);
CREATE INDEX idx_fu_outcomes_terugkom ON public.follow_up_outcomes(terugkom_datum) WHERE terugkom_datum IS NOT NULL;
CREATE INDEX idx_fu_outcomes_status ON public.follow_up_outcomes(opvolging_status) WHERE opvolging_status IS NOT NULL;

ALTER TABLE public.follow_up_outcomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Inherit from appointment (SELECT)"
  ON public.follow_up_outcomes
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.follow_up_appointments fa
      WHERE fa.id = appointment_id
        AND (fa.owner_id = auth.uid() OR public.has_any_role(ARRAY['super_admin','admin','manager']))
    )
  );

CREATE POLICY "Inherit from appointment (ALL)"
  ON public.follow_up_outcomes
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.follow_up_appointments fa
      WHERE fa.id = appointment_id
        AND (fa.owner_id = auth.uid() OR public.has_any_role(ARRAY['super_admin','admin','manager']))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.follow_up_appointments fa
      WHERE fa.id = appointment_id
        AND (fa.owner_id = auth.uid() OR public.has_any_role(ARRAY['super_admin','admin','manager']))
    )
  );

-- =============================================================================
-- 3. follow_up_messages
-- =============================================================================

CREATE TABLE public.follow_up_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ghl_message_id text UNIQUE NOT NULL,
  ghl_conversation_id text NOT NULL,
  lead_ghl_contact_id text NOT NULL,
  appointment_id uuid REFERENCES public.follow_up_appointments(id) ON DELETE SET NULL,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  channel text NOT NULL CHECK (channel IN ('whatsapp','email','sms')),
  body text,
  template_id text,
  template_variables jsonb,
  sent_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('webhook','polling_sync','initial_sync'))
);

CREATE INDEX idx_fu_messages_conversation ON public.follow_up_messages(ghl_conversation_id);
CREATE INDEX idx_fu_messages_contact ON public.follow_up_messages(lead_ghl_contact_id);
CREATE INDEX idx_fu_messages_appointment ON public.follow_up_messages(appointment_id) WHERE appointment_id IS NOT NULL;
CREATE INDEX idx_fu_messages_sent_at ON public.follow_up_messages(sent_at);

ALTER TABLE public.follow_up_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Sales eigen lead messages + ADMIN_ROLES alles (SELECT)"
  ON public.follow_up_messages
  FOR SELECT TO authenticated
  USING (
    public.has_any_role(ARRAY['super_admin','admin','manager'])
    OR EXISTS (
      SELECT 1 FROM public.follow_up_appointments fa
      WHERE fa.lead_ghl_contact_id = follow_up_messages.lead_ghl_contact_id
        AND fa.owner_id = auth.uid()
    )
  );

CREATE POLICY "ADMIN_ROLES + system write"
  ON public.follow_up_messages
  FOR ALL TO authenticated
  USING (public.has_any_role(ARRAY['super_admin','admin','manager']))
  WITH CHECK (public.has_any_role(ARRAY['super_admin','admin','manager']));

-- =============================================================================
-- 4. follow_up_messages_sent (GHL workflow triggers tracking)
-- =============================================================================

CREATE TABLE public.follow_up_messages_sent (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES public.follow_up_appointments(id) ON DELETE CASCADE,
  trigger_type text NOT NULL
    CHECK (trigger_type IN ('no_show_immediate','no_show_24h','drip_per_bezwaar','opvolging_reminder')),
  ghl_workflow_id text,
  triggered_at timestamptz NOT NULL DEFAULT now(),
  ghl_response_status text
    CHECK (ghl_response_status IN ('triggered','failed','completed') OR ghl_response_status IS NULL),
  lead_responded boolean NOT NULL DEFAULT false,
  lead_responded_at timestamptz
);

CREATE INDEX idx_fu_msgsent_appointment ON public.follow_up_messages_sent(appointment_id);
CREATE INDEX idx_fu_msgsent_trigger ON public.follow_up_messages_sent(trigger_type);
CREATE INDEX idx_fu_msgsent_triggered ON public.follow_up_messages_sent(triggered_at);

ALTER TABLE public.follow_up_messages_sent ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Inherit from appointment (SELECT)"
  ON public.follow_up_messages_sent
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.follow_up_appointments fa
      WHERE fa.id = appointment_id
        AND (fa.owner_id = auth.uid() OR public.has_any_role(ARRAY['super_admin','admin','manager']))
    )
  );

CREATE POLICY "ADMIN_ROLES + system write"
  ON public.follow_up_messages_sent
  FOR ALL TO authenticated
  USING (public.has_any_role(ARRAY['super_admin','admin','manager']))
  WITH CHECK (public.has_any_role(ARRAY['super_admin','admin','manager']));

-- =============================================================================
-- 5. follow_up_events_log
-- =============================================================================

CREATE TABLE public.follow_up_events_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('ghl','zoom','manual','cron')),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed boolean NOT NULL DEFAULT false
);

CREATE INDEX idx_fu_events_source ON public.follow_up_events_log(source);
CREATE INDEX idx_fu_events_received ON public.follow_up_events_log(received_at);
CREATE INDEX idx_fu_events_processed ON public.follow_up_events_log(processed) WHERE processed = false;

ALTER TABLE public.follow_up_events_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ADMIN_ROLES only"
  ON public.follow_up_events_log
  FOR ALL TO authenticated
  USING (public.has_any_role(ARRAY['super_admin','admin','manager']))
  WITH CHECK (public.has_any_role(ARRAY['super_admin','admin','manager']));

-- =============================================================================
-- 6. follow_up_screenshot_audit
-- =============================================================================

CREATE TABLE public.follow_up_screenshot_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  screenshot_url text NOT NULL,
  appointment_id uuid NOT NULL REFERENCES public.follow_up_appointments(id) ON DELETE CASCADE,
  ai_review_result text NOT NULL CHECK (ai_review_result IN ('ok','suspicious','missing')),
  ai_review_reasoning text,
  admin_reviewed boolean NOT NULL DEFAULT false,
  admin_reviewer_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  review_notes text,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_fu_screenshot_sales ON public.follow_up_screenshot_audit(sales_user_id);
CREATE INDEX idx_fu_screenshot_appointment ON public.follow_up_screenshot_audit(appointment_id);
CREATE INDEX idx_fu_screenshot_review ON public.follow_up_screenshot_audit(ai_review_result, admin_reviewed);

ALTER TABLE public.follow_up_screenshot_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Sales own + ADMIN_ROLES all (SELECT)"
  ON public.follow_up_screenshot_audit
  FOR SELECT TO authenticated
  USING (
    sales_user_id = auth.uid()
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

CREATE POLICY "Sales insert own + ADMIN_ROLES all"
  ON public.follow_up_screenshot_audit
  FOR ALL TO authenticated
  USING (
    sales_user_id = auth.uid()
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  )
  WITH CHECK (
    sales_user_id = auth.uid()
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

-- =============================================================================
-- 7. follow_up_notifications_sent
-- =============================================================================

CREATE TABLE public.follow_up_notifications_sent (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  notification_type text NOT NULL
    CHECK (notification_type IN ('dave_eod','admin_daily_flag','admin_weekly','admin_screenshot_review')),
  sent_at timestamptz NOT NULL DEFAULT now(),
  channel text NOT NULL CHECK (channel IN ('whatsapp_ghl','email','in_app')),
  payload_summary jsonb
);

CREATE INDEX idx_fu_notif_recipient ON public.follow_up_notifications_sent(recipient_user_id);
CREATE INDEX idx_fu_notif_type ON public.follow_up_notifications_sent(notification_type);
CREATE INDEX idx_fu_notif_sent ON public.follow_up_notifications_sent(sent_at);

ALTER TABLE public.follow_up_notifications_sent ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Recipient own + ADMIN_ROLES all"
  ON public.follow_up_notifications_sent
  FOR SELECT TO authenticated
  USING (
    recipient_user_id = auth.uid()
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

CREATE POLICY "ADMIN_ROLES + system write"
  ON public.follow_up_notifications_sent
  FOR ALL TO authenticated
  USING (public.has_any_role(ARRAY['super_admin','admin','manager']))
  WITH CHECK (public.has_any_role(ARRAY['super_admin','admin','manager']));

-- =============================================================================
-- 8. Trigger voor automatische updated_at op follow_up_appointments
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fu_appointments_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fu_appointments_updated_at
  BEFORE UPDATE ON public.follow_up_appointments
  FOR EACH ROW
  EXECUTE FUNCTION public.fu_appointments_set_updated_at();

-- =============================================================================
-- 9. Supabase Storage bucket voor screenshots
-- =============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'follow-up-screenshots',
  'follow-up-screenshots',
  false,
  10485760,
  ARRAY['image/png','image/jpeg','image/jpg','image/webp']
)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Sales upload own screenshots"
  ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'follow-up-screenshots'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Sales view own + ADMIN_ROLES view all screenshots"
  ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'follow-up-screenshots'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR public.has_any_role(ARRAY['super_admin','admin','manager'])
    )
  );

CREATE POLICY "ADMIN_ROLES delete screenshots (cleanup)"
  ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'follow-up-screenshots'
    AND public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

COMMIT;

-- =============================================================================
-- VERIFICATIE-QUERIES (na deploy uitvoeren)
-- =============================================================================

-- Verifieer dat alle 7 tabellen bestaan:
-- SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'follow_up_%' ORDER BY tablename;

-- Verifieer RLS aan op alle 7:
-- SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'follow_up_%';

-- Verifieer policies:
-- SELECT tablename, policyname FROM pg_policies WHERE schemaname='public' AND tablename LIKE 'follow_up_%' ORDER BY tablename, policyname;

-- Verifieer storage bucket:
-- SELECT id, name, public FROM storage.buckets WHERE id='follow-up-screenshots';
