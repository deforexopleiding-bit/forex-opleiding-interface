-- 2026-09-04 · Afspraak-reminders — EENMALIG go-live-backfill, ALLE AGENDA'S
--
-- ⚠️ LOS EENMALIG SCRIPT (geen vaste migratie). Draai HANDMATIG in de Supabase
--    SQL-editor, één keer, vlak vóór je AFSPRAAK_REMINDERS_LIVE aanzet. Alles
--    wordt tegen now() gerekend.
--
-- Dit is de VERBREDE variant van 2026-09-04-afspraak-golive-backfill-eenmalig.sql:
-- dezelfde bovengrens-logica, maar de opstartsessie_submissions-EXISTS-filter is
-- vervangen door ghl_calendar_id IS NOT NULL, zodat álle bestaande calls van álle
-- GHL-agenda's (vóór ons systeem geboekt) meedoen.
--
-- WAT
--   * bevestiging_sent_at = now() (lead kreeg de bevestiging al via GHL);
--   * onderdruk elk reminder-moment waarvan het venster t.o.v. scheduled_at AL
--     geopend is (resterende tijd <= EIGEN bovengrens) → geen directe burst;
--   * nog-toekomstige momenten blijven NULL zodat die normaal vuren.
--
-- BOVENGRENZEN:
--   reminder_24u_at : onderdruk als scheduled_at - now() <= interval '24 hours'
--   reminder_2u_at  : onderdruk als scheduled_at - now() <= interval '2 hours'
--   reminder_30m_at : onderdruk als scheduled_at - now() <= interval '30 minutes'
--   zoom_5min_at    : onderdruk als scheduled_at - now() <= interval '5 minutes'
--
-- SCOPE: status='scheduled' AND scheduled_at > now() AND ghl_calendar_id IS NOT NULL
--        (= precies wat de verbrede reminder-cron oppakt).
--
-- IDEMPOTENT: alleen NULL-guards worden gezet. Draai één keer, kort vóór go-live.
-- VOORWAARDE: draai dit NÁ de per-calendar import (zodat ghl_calendar_id gevuld is).

BEGIN;

WITH doelwit AS (
  SELECT a.id
  FROM public.follow_up_appointments a
  WHERE a.status = 'scheduled'
    AND a.scheduled_at > now()
    AND a.ghl_calendar_id IS NOT NULL
)
UPDATE public.follow_up_appointments a
SET
  bevestiging_sent_at = COALESCE(a.bevestiging_sent_at, now()),

  reminder_24u_at = CASE
    WHEN a.reminder_24u_at IS NULL AND (a.scheduled_at - now()) <= interval '24 hours'
    THEN now() ELSE a.reminder_24u_at END,

  reminder_2u_at = CASE
    WHEN a.reminder_2u_at IS NULL AND (a.scheduled_at - now()) <= interval '2 hours'
    THEN now() ELSE a.reminder_2u_at END,

  reminder_30m_at = CASE
    WHEN a.reminder_30m_at IS NULL AND (a.scheduled_at - now()) <= interval '30 minutes'
    THEN now() ELSE a.reminder_30m_at END,

  zoom_5min_at = CASE
    WHEN a.zoom_5min_at IS NULL AND (a.scheduled_at - now()) <= interval '5 minutes'
    THEN now() ELSE a.zoom_5min_at END
FROM doelwit d
WHERE a.id = d.id;

COMMIT;

-- ============================================================================
-- VERIFICATIE (draai NA COMMIT)
-- ============================================================================
--   SELECT ghl_calendar_id,
--          count(*)                                  AS totaal,
--          count(*) FILTER (WHERE bevestiging_sent_at IS NOT NULL) AS bevestiging_gezet,
--          count(*) FILTER (WHERE reminder_24u_at IS NULL)         AS r24_nog_te_sturen
--   FROM public.follow_up_appointments a
--   WHERE a.status='scheduled' AND a.scheduled_at > now() AND a.ghl_calendar_id IS NOT NULL
--   GROUP BY ghl_calendar_id ORDER BY 2 DESC;
--
--   -- Sanity: geen scheduled+future agenda-afspraak meer zonder bevestiging:
--   SELECT count(*) FROM public.follow_up_appointments
--   WHERE status='scheduled' AND scheduled_at > now() AND ghl_calendar_id IS NOT NULL
--     AND bevestiging_sent_at IS NULL;  -- verwacht 0
--
-- ============================================================================
-- TERUGDRAAIEN (alleen als de reminder-cron nog NOOIT live heeft gedraaid)
-- ============================================================================
--   UPDATE public.follow_up_appointments
--   SET bevestiging_sent_at=NULL, reminder_24u_at=NULL, reminder_2u_at=NULL,
--       reminder_30m_at=NULL, zoom_5min_at=NULL
--   WHERE status='scheduled' AND scheduled_at > now() AND ghl_calendar_id IS NOT NULL;
-- ============================================================================
