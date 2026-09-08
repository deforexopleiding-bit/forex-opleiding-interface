-- ============================================================================
-- Funnel-eigen event-berichten — verzendlog (dubbel-preventie)
-- Datum: 2026-09-08
--
-- Eén rij per (attendee, soort) bericht dat het FUNNEL-EIGEN pad (finalize +
-- de nieuwe cron cron-events-website-berichten) heeft verstuurd. De UNIQUE
-- index dwingt af dat elk berichttype hooguit één keer per aanwezige uitgaat.
--
-- Raakt de oude GHL-flow NIET: aparte tabel, alleen gebruikt door code die
-- uitsluitend created_via='website'-attendees selecteert. event_automations /
-- automation_enabled / de engine blijven ongemoeid.
--
-- soort ∈ { bevestiging, vervolg_2u, vervolg_24u, warmup, reminder_24u, reminder_1u }
--
-- Geen wijziging op bestaande tabellen. Wél nieuwe tabel → draai na afloop
-- NOTIFY pgrst, 'reload schema'; zodat PostgREST de tabel kent.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.event_website_berichten (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attendee_id  uuid NOT NULL REFERENCES public.event_attendees(id) ON DELETE CASCADE,
  event_id     uuid REFERENCES public.events(id) ON DELETE SET NULL,
  soort        text NOT NULL,   -- bevestiging | vervolg_2u | vervolg_24u | warmup | reminder_24u | reminder_1u
  kanaal       text,            -- informatief, bv. 'mail+whatsapp'
  sent_at      timestamptz NOT NULL DEFAULT now()
);

-- Precies één markering per (attendee, soort) → harde dubbel-preventie.
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_website_berichten_att_soort
  ON public.event_website_berichten (attendee_id, soort);

CREATE INDEX IF NOT EXISTS idx_event_website_berichten_event
  ON public.event_website_berichten (event_id);

ALTER TABLE public.event_website_berichten ENABLE ROW LEVEL SECURITY;
-- Bewust GEEN policies: alleen de service-role (cron + finalize) schrijft/leest.

COMMIT;

-- Verificatie:
--   SELECT to_regclass('public.event_website_berichten');
--   SELECT indexname FROM pg_indexes WHERE tablename='event_website_berichten';
-- NOTIFY pgrst, 'reload schema';
