-- 027_backfill_attendee_status_from_attendance.sql
--
-- DATACORRECTIE — GEEN schema-wijziging.
--
-- Trekt event_attendees.status (lifecycle-kolom) gelijk met
-- attendance_status voor reeds-afgeronde events waar de oude
-- events-complete-flow status='aangemeld' liet staan terwijl
-- attendance_status wel gezet was.
--
-- Waarom: Opvolglijst-tab (api/follow-up-opvolglijst.js) filtert op
-- event_attendees.status='no_show'. Vóór deze fix bleef status op
-- 'aangemeld' staan → no-shows verdwenen. Fix in events-complete-core
-- lost dat voor NIEUWE afrondingen op; deze SQL trekt de bestaande
-- 7 attendees van 'Basis Forex Masterclass Gent' (en overige historische
-- afrondingen) gelijk.
--
-- Mapping (identiek aan STATUS_MAP in events-complete-core.js):
--   attendance_status='aanwezig' → status='aanwezig'
--   attendance_status='no_show'  → status='no_show'
--   attendance_status='afgemeld' → status='geannuleerd'
--
-- Timestamp-kolommen (attended_at, no_show_marked_at) worden gezet
-- op NOW() bij ontbrekende waarden — enkel als de kolommen bestaan
-- (idempotent via COALESCE).
--
-- SAFETY:
-- - Update ALLEEN rijen op events waar completed_at IS NOT NULL
--   (reeds afgerond via de UI).
-- - Alleen waar status='aangemeld' (nog niet handmatig gecorrigeerd).
-- - Alleen waar attendance_status ∈ ('aanwezig','no_show','afgemeld').
-- - switched_to_other_event blijft ongemoeid (staat sowieso niet op
--   'aangemeld' meer).
-- - Idempotent: herhaald draaien heeft geen extra effect zodra
--   status ≠ 'aangemeld' is.

update event_attendees ea
   set status = case ea.attendance_status
                  when 'aanwezig' then 'aanwezig'
                  when 'no_show'  then 'no_show'
                  when 'afgemeld' then 'geannuleerd'
                  else ea.status
                end,
       attended_at        = case when ea.attendance_status='aanwezig' then coalesce(ea.attended_at,       now()) else ea.attended_at end,
       no_show_marked_at  = case when ea.attendance_status='no_show'  then coalesce(ea.no_show_marked_at, now()) else ea.no_show_marked_at end
  from events e
 where ea.event_id = e.id
   and e.completed_at is not null
   and ea.status = 'aangemeld'
   and ea.attendance_status in ('aanwezig','no_show','afgemeld');

-- Verificatie-query (draai apart om te bevestigen dat alles gelijk staat):
-- select ea.id, ea.status, ea.attendance_status, e.title
--   from event_attendees ea join events e on e.id = ea.event_id
--  where e.completed_at is not null
--    and ea.status = 'aangemeld'
--    and ea.attendance_status is not null;
-- (Verwacht: 0 rijen na deze update.)

notify pgrst, 'reload schema';
