-- 028_backfill_event_followups_to_leads.sql
--
-- DATACORRECTIE — GEEN schema-wijziging.
--
-- Bestaande open event_followups die nog geen bijbehorende
-- follow_up_leads-lead hebben, worden alsnog als event-lead
-- aangemaakt. Zo verschijnen ze in de Werklijst-cockpit met de
-- 'Follow-up event'-badge (via source_ref.is_event_followup=true)
-- op de geplande follow-up-datum (terugbel_datum).
--
-- Waarom: vóór PR-A wachtte de lead-aanmaak op een 'Bel nu'-klik in
-- de verborgen 'event-followups'-tab. Bestaande follow-ups (bv.
-- Fabio, event_followup 6ad6d485-...) leefden dus in event_followups
-- maar niet in follow_up_leads → nergens zichtbaar in de cockpit.
--
-- Idempotency: skip als er al een open event-lead voor deze attendee
-- (via source_ref.attendee_id) OF via (customer_id, source='event')
-- bestaat met een niet-afgesloten lead_status.
--
-- NULL-veilig: bij ontbrekende voornaam+achternaam valt lead_name
-- terug op de e-mail, dan op '(onbekend)'.

insert into follow_up_leads (
  customer_id,
  source,
  lead_name,
  lead_email,
  lead_phone,
  lead_status,
  terugbel_datum,
  source_ref,
  created_by_user_id
)
select
  ea.customer_id,
  'event' as source,
  coalesce(
    nullif(trim(coalesce(ea.first_name, '') || ' ' || coalesce(ea.last_name, '')), ''),
    ea.email,
    '(onbekend)'
  ) as lead_name,
  ea.email as lead_email,
  ea.phone as lead_phone,
  'nieuw' as lead_status,
  ef.follow_up_date as terugbel_datum,
  jsonb_build_object(
    'event_id',         ef.event_id,
    'attendee_id',      ea.id,
    'is_event_followup', true,
    'followup_id',      ef.id,
    'reason',           ef.reason
  ) as source_ref,
  ef.created_by as created_by_user_id
  from event_followups ef
  join event_attendees ea on ea.id = ef.attendee_id
 where ef.status = 'open'
   -- Skip als er al een open event-lead voor deze attendee bestaat
   -- (dekt zowel customer_id-basis als naam-basis).
   and not exists (
     select 1 from follow_up_leads fl
      where fl.source = 'event'
        and fl.source_ref->>'attendee_id' = ea.id::text
        and fl.lead_status not in ('verlengd','verloren')
   )
   -- Skip als er al een open event-lead voor deze customer_id bestaat
   -- (dekt oudere leads die het attendee_id nog niet in source_ref hadden).
   and (
     ea.customer_id is null
     or not exists (
       select 1 from follow_up_leads fl2
        where fl2.source      = 'event'
          and fl2.customer_id = ea.customer_id
          and fl2.lead_status not in ('verlengd','verloren')
     )
   );

-- Verificatie-query (draai apart):
-- select ef.id, ea.first_name, ea.last_name, ea.email, ef.follow_up_date
--   from event_followups ef
--   join event_attendees ea on ea.id = ef.attendee_id
--  where ef.status = 'open'
--    and not exists (
--      select 1 from follow_up_leads fl
--       where fl.source = 'event'
--         and (fl.source_ref->>'attendee_id' = ea.id::text
--              or (fl.customer_id is not null and fl.customer_id = ea.customer_id))
--         and fl.lead_status not in ('verlengd','verloren')
--    );
-- (Verwacht: 0 rijen na de INSERT.)

notify pgrst, 'reload schema';
