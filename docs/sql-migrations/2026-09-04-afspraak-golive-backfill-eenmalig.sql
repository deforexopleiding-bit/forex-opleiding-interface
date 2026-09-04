-- 2026-09-04 · Afspraak-reminders — EENMALIG go-live-backfill (GEEN vaste migratie)
--
-- ⚠️ DIT IS EEN LOS EENMALIG SCRIPT, geen onderdeel van de normale schema-migratie-
--    keten. Draai het HANDMATIG in de Supabase SQL-editor, één keer, vlak vóór je
--    AFSPRAAK_REMINDERS_LIVE aanzet. Alles wordt tegen now() gerekend.
--
-- WAAROM
-- Calls die al in GHL geboekt waren vóór de in-house reminder-flow: de lead heeft
-- de bevestiging al via GHL gekregen, en een deel van de reminder-momenten is qua
-- timing al "aan de beurt geweest". Dit script zet de guard-kolommen zó dat:
--   * er GEEN nieuwe bevestiging uitgaat (bevestiging_sent_at = now());
--   * een reminder wordt onderdrukt zodra zijn verzendvenster t.o.v. scheduled_at
--     AL geopend is (resterende tijd <= de EIGEN drempel van dat moment) →
--     BOVENGRENS-variant, dus GEEN directe burst bij go-live;
--   * nog-echt-toekomstige momenten NULL blijven zodat die normaal vuren.
--
-- DREMPELS (bovengrenzen, = de "boven"-edges uit api/_lib/afspraak-berichten.js):
--   reminder_24u_at : onderdruk als scheduled_at - now() <= interval '24 hours'
--   reminder_2u_at  : onderdruk als scheduled_at - now() <= interval '2 hours'
--   reminder_30m_at : onderdruk als scheduled_at - now() <= interval '30 minutes'
--   zoom_5min_at    : onderdruk als scheduled_at - now() <= interval '5 minutes'
--
-- SCOPE
--   status = 'scheduled'  AND  scheduled_at > now()
--   AND gekoppeld aan een opstartsessie_submissions-rij (appointment_id) — precies
--   de afspraken die de reminder-cron oppakt. Direct-in-GHL geboekte calls zonder
--   submission-koppeling worden door de cron sowieso genegeerd → hier terecht buiten.
--
-- IDEMPOTENT
--   Alleen NULL-guards worden gezet (COALESCE / CASE ... WHEN <kolom> IS NULL).
--   Re-run is veilig en overschrijft niets. Let op: bij een LATERE re-run rekent
--   'ie opnieuw tegen de dan-geldende now() — draai 'm dus één keer, kort vóór
--   go-live (zie go-live-volgorde in de PR-omschrijving).

BEGIN;

WITH doelwit AS (
  SELECT a.id
  FROM public.follow_up_appointments a
  WHERE a.status = 'scheduled'
    AND a.scheduled_at > now()
    AND EXISTS (
      SELECT 1 FROM public.opstartsessie_submissions s
      WHERE s.appointment_id = a.id
    )
)
UPDATE public.follow_up_appointments a
SET
  -- Bevestiging al door GHL verstuurd bij het boeken → nooit opnieuw sturen.
  bevestiging_sent_at = COALESCE(a.bevestiging_sent_at, now()),

  -- Onderdruk elk moment waarvan het verzendvenster AL geopend is (resterende
  -- tijd <= eigen bovengrens). Anders NULL laten → vuurt normaal wanneer het
  -- venster ingaat.
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
-- 1) Overzicht van de geraakte afspraken + welke guards gezet zijn:
--    SELECT id, scheduled_at,
--           (scheduled_at - now())               AS resterend,
--           bevestiging_sent_at IS NOT NULL       AS bevestiging_gezet,
--           reminder_24u_at IS NOT NULL           AS r24_onderdrukt,
--           reminder_2u_at  IS NOT NULL           AS r2_onderdrukt,
--           reminder_30m_at IS NOT NULL           AS r30_onderdrukt,
--           zoom_5min_at    IS NOT NULL           AS zoom5_onderdrukt
--    FROM public.follow_up_appointments a
--    WHERE a.status = 'scheduled' AND a.scheduled_at > now()
--      AND EXISTS (SELECT 1 FROM public.opstartsessie_submissions s WHERE s.appointment_id = a.id)
--    ORDER BY a.scheduled_at;
--
--    Verwacht (bovengrens-variant): geen enkel moment waarvan het venster nú al
--    open is blijft NULL; alle nog-toekomstige momenten zijn NULL.
--
-- 2) Sanity: er mag geen 'scheduled' toekomstige gekoppelde afspraak meer zijn
--    met bevestiging_sent_at IS NULL:
--    SELECT count(*) AS zonder_bevestiging
--    FROM public.follow_up_appointments a
--    WHERE a.status='scheduled' AND a.scheduled_at > now()
--      AND a.bevestiging_sent_at IS NULL
--      AND EXISTS (SELECT 1 FROM public.opstartsessie_submissions s WHERE s.appointment_id = a.id);
--    Verwacht: 0.
--
-- ============================================================================
-- TERUGDRAAIEN (alleen als je vóór go-live besluit toch niets te backfillen)
-- ============================================================================
-- Let op: dit reset guards die door dit script gezet zijn NIET selectief — het
-- kan niet onderscheiden welke now()-waarden van dit script kwamen. Gebruik enkel
-- als de reminder-cron nog NOOIT live heeft gedraaid (anders wis je echte sends):
--   UPDATE public.follow_up_appointments a
--   SET bevestiging_sent_at=NULL, reminder_24u_at=NULL, reminder_2u_at=NULL,
--       reminder_30m_at=NULL, zoom_5min_at=NULL
--   WHERE a.status='scheduled' AND a.scheduled_at > now()
--     AND EXISTS (SELECT 1 FROM public.opstartsessie_submissions s WHERE s.appointment_id = a.id);
-- ============================================================================
