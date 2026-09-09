-- ============================================================================
-- Call-bevestiging (kennismakingsgesprek) — per-kanaal-markers + faillog
-- Datum: 2026-09-09
--
-- Twee dingen, allebei ALLEEN voor het 'bevestiging'-moment + observability;
-- de reminder-kolommen (reminder_24u_at / _2u_at / _30m_at / zoom_5min_at) en
-- hun timing/logica blijven ONGEWIJZIGD.
--
-- 1) Per-kanaal-markers op follow_up_appointments zodat een volgende cron-run
--    een mislukte WhatsApp opnieuw kan proberen ZONDER de mail nóg eens te
--    sturen. bevestiging_sent_at blijft de "volledig-klaar"-markering (beide
--    toepasselijke kanalen gelukt) en wordt gebruikt als guard/kandidaatfilter.
--
-- 2) Faillog-tabel: elke mislukte verzending (whatsapp/email) met reden+tijd,
--    zodat stille fouten zichtbaar worden.
--
-- Nieuwe kolommen + tabel → draai na afloop: NOTIFY pgrst, 'reload schema';
-- Idempotent: IF NOT EXISTS.
-- ============================================================================

BEGIN;

-- 1) Per-kanaal-markers (alleen voor bevestiging).
ALTER TABLE public.follow_up_appointments
  ADD COLUMN IF NOT EXISTS bevestiging_wa_sent_at   timestamptz,
  ADD COLUMN IF NOT EXISTS bevestiging_mail_sent_at timestamptz;

COMMENT ON COLUMN public.follow_up_appointments.bevestiging_wa_sent_at IS
  'Tijdstip waarop de bevestiging-WhatsApp geslaagd verstuurd is. NULL = nog niet / opnieuw te proberen. Los van bevestiging_mail_sent_at zodat WA kan retryen zonder dubbele mail.';
COMMENT ON COLUMN public.follow_up_appointments.bevestiging_mail_sent_at IS
  'Tijdstip waarop de bevestiging-mail geslaagd verstuurd is. NULL = nog niet / opnieuw te proberen.';

-- 2) Faillog voor de afspraak-berichtenflow.
CREATE TABLE IF NOT EXISTS public.afspraak_bericht_faillog (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid REFERENCES public.follow_up_appointments(id) ON DELETE CASCADE,
  moment         text,        -- bevestiging | r24 | r2 | r30 | r5
  kanaal         text,        -- whatsapp | email
  template_name  text,
  reason         text,
  http_status    integer,
  to_phone       text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_afspraak_bericht_faillog_appt
  ON public.afspraak_bericht_faillog (appointment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_afspraak_bericht_faillog_recent
  ON public.afspraak_bericht_faillog (created_at DESC);

ALTER TABLE public.afspraak_bericht_faillog ENABLE ROW LEVEL SECURITY;
-- Alleen service-role (de cron) schrijft/leest; geen policies (net als de
-- andere interne log-tabellen).

COMMIT;

-- Verificatie:
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name='follow_up_appointments'
--       AND column_name IN ('bevestiging_wa_sent_at','bevestiging_mail_sent_at');
--   SELECT to_regclass('public.afspraak_bericht_faillog');
-- NOTIFY pgrst, 'reload schema';
