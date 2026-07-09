-- 026_event_attendees_switched_to_event_id.sql
--
-- Bij het verplaatsen van een aanwezige naar een ander event (via
-- api/events-attendee-move.js) krijgt de nieuwe rij al
-- switched_from_event_id (herkomst); de bron-rij krijgt
-- status='switched_to_other_event' + switched_at, maar niet naar
-- welk event 'ie ging. Deze kolom voegt die bestemming toe, zodat
-- events-detail.html kan tonen: "Verplaatst → [naam doel-event]".
--
-- Kolom bewust NULLABLE + geen backfill: legacy verplaatsingen
-- (vóór deze migratie) hebben geen bestemming meer beschikbaar. De
-- UI toont in dat geval gewoon "Verplaatst" (graceful fallback).

alter table event_attendees add column if not exists switched_to_event_id uuid references events(id);

notify pgrst, 'reload schema';
