-- supabase/restore-wacht-op-reschedule-preview.sql
--
-- CONTEXT
-- =======
-- De ghost-cleanup in api/follow-up-ghl-appointment-poll.js (regel 250-283)
-- flipte toekomstige opstartsessies onterecht van 'scheduled' naar
-- 'wacht_op_reschedule' omdat de /calendars/events fetch incompleet was
-- (paginatie stuk in PR #1531; herstelt door de reparatie-PR). Deze calls
-- staan nog gewoon in GHL en moeten terug naar 'scheduled'.
--
-- Tabel: public.follow_up_appointments
-- Kolommen (uit api/leadsonderhoud-opstartsessies-list.js:317):
--   id                   uuid    (primary key)
--   lead_name            text
--   lead_email           text
--   lead_phone           text
--   scheduled_at         timestamptz  (de afspraak-datetime)
--   status               text
--   ghl_calendar_id      text    (GHL-agenda-id — kennismakings-calendar
--                                 = 'Zk3jC3eSyQHPOD9BtvXx')
--   ghl_appointment_id   text    (GHL event-id)
--
-- 0 incasso-writes. Raakt uitsluitend follow_up_appointments.status voor
-- rijen die voldoen aan strikte filter (toekomst + wacht_op_reschedule +
-- ghl_calendar_id + ghl_appointment_id gevuld).

-- ═══════════════════════════════════════════════════════════════════════
-- BLOK 1: PREVIEW — alleen SELECT, verandert niks
-- ═══════════════════════════════════════════════════════════════════════
--
-- Draai eerst dit blok. Rapporteer het aantal + de detail-lijst (naam,
-- datum, agenda) zodat we blast-radius kennen vóór BLOK 2.

SELECT
  id,
  lead_name,
  lead_email,
  lead_phone,
  scheduled_at,
  status,
  ghl_calendar_id,
  ghl_appointment_id
FROM public.follow_up_appointments
WHERE status              = 'wacht_op_reschedule'
  AND scheduled_at       >= now()
  AND ghl_calendar_id     IS NOT NULL
  AND ghl_appointment_id  IS NOT NULL
ORDER BY scheduled_at;

-- Snelle telquery voor het aantal (los draaien of onderaan BLOK 1):
--
-- SELECT count(*) AS te_herstellen
--   FROM public.follow_up_appointments
--  WHERE status              = 'wacht_op_reschedule'
--    AND scheduled_at       >= now()
--    AND ghl_calendar_id     IS NOT NULL
--    AND ghl_appointment_id  IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- BLOK 2: RESTORE — UPDATE, pas draaien NA akkoord op preview
-- ═══════════════════════════════════════════════════════════════════════
--
-- Zelfde WHERE-voorwaarden als BLOK 1. Alleen rijen die exact matchen
-- worden geraakt. Idempotent: tweede run raakt 0 rijen (want status is
-- dan 'scheduled', WHERE-clause matcht niet meer).
--
-- Draai binnen een transactie zodat je bij een rare uitkomst kunt
-- ROLLBACK'en vóór commit.

BEGIN;

UPDATE public.follow_up_appointments
   SET status     = 'scheduled',
       updated_at = now()
 WHERE status              = 'wacht_op_reschedule'
   AND scheduled_at       >= now()
   AND ghl_calendar_id     IS NOT NULL
   AND ghl_appointment_id  IS NOT NULL
RETURNING id, lead_name, scheduled_at, status;

-- Verifieer aantal RETURNED matches met het preview-aantal.
-- Als het klopt: COMMIT. Als het afwijkt: ROLLBACK.

-- COMMIT;
-- ROLLBACK;

-- ═══════════════════════════════════════════════════════════════════════
-- POST-CHECK (na COMMIT, in aparte tab)
-- ═══════════════════════════════════════════════════════════════════════
--
-- SELECT count(*) AS resterend_wacht_op_reschedule_toekomst
--   FROM public.follow_up_appointments
--  WHERE status              = 'wacht_op_reschedule'
--    AND scheduled_at       >= now()
--    AND ghl_calendar_id     IS NOT NULL
--    AND ghl_appointment_id  IS NOT NULL;
-- Verwacht: 0.
--
-- Kennismakingsgesprekken-UI (leadsonderhoud/Opstartsessies) toont nu de
-- toekomstige weken met de juiste calls i.p.v. lege gaten.
