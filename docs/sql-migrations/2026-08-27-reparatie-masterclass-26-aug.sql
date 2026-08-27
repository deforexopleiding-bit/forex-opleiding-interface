-- ============================================================================
--  REPARATIE — masterclass van 26 augustus 2026
--  event 6a848f55-c782-4a3f-b46e-ccb11d10eabf
-- ============================================================================
--  Dit is GEEN schema-migratie maar een eenmalige datacorrectie voor drie
--  mensen die door twee fouten uit beeld raakten. Die fouten zijn in de code
--  gerepareerd; dit haalt in wat er al misging.
--
--  IDEMPOTENT. Elke stap kijkt eerst of het werk al gedaan is. Twee keer
--  draaien verandert niets extra, en er wordt niets verwijderd of overschreven.
--
--  WAT ER MIS WAS
--  --------------
--  1. Ioan Berintan en Lina Mavzer stonden op no-show. Er is een notitie bij
--     hen getypt, maar geen reden aangeklikt. Het scherm stuurde het blok toen
--     alleen mee als er ÉN een reden ÉN een belmoment stond, dus ging alles
--     mee de prullenbak in: geen opvolgrij, geen belrij, notitie weg.
--  2. Arslan Khan kreeg bij het afronden alles goed — opvolgrij, reden
--     'onbekend', notitie bewaard. Toch stond hij nergens, want hij had al een
--     follow_up_leads-rij van vóór het event met lead_status 'verloren' en
--     zonder terugbel_datum. Het afronden zocht alleen naar OPEN rijen, vond
--     niets, en liet de gesloten rij liggen.
--
--  WAT IK NIET KAN HERSTELLEN
--  --------------------------
--  De notitie van Ioan en Lina is echt weg. Die is nooit de browser uit
--  gekomen — er is geen kolom, geen log en geen back-up waar hij in staat.
--  Stap 2 zet daarom een regel in hun notitielog die zegt DAT er een notitie
--  was en dat die verloren ging, zodat de beller niet denkt dat er niets over
--  hen bekend was. Weet Maxim nog wat er stond, dan kan het er alsnog bij.
--
--  WAAROM OP NAAM EN NIET OP ID
--  ----------------------------
--  Ik heb geen toegang tot de databank en ken hun attendee-id's niet. De
--  stappen zoeken daarom binnen dit ene event op naam. Stap 0 laat zien wie
--  er gevonden wordt — controleer dat vóór je verder gaat.
--
--  ── DRAAIEN ────────────────────────────────────────────────────────────────
--  Nog NIET gedraaid. Stap voor stap in de Supabase SQL-editor, en na elke
--  stap even kijken of het aantal klopt.
-- ============================================================================


-- ── Stap 0 — WIE gaat dit raken? (lezen, verandert niets) ───────────────────
-- Verwacht drie rijen: Ioan Berintan en Lina Mavzer met status no_show, en
-- Arslan Khan. Staan er meer of andere namen, STOP dan en pas de filters aan.
select a.id            as attendee_id,
       a.first_name, a.last_name,
       a.status, a.attendance_status, a.outcome,
       a.customer_id,
       (select count(*) from public.event_followups f
         where f.attendee_id = a.id and f.status = 'open')          as open_followups,
       (select count(*) from public.follow_up_leads l
         where l.source_ref->>'attendee_id' = a.id::text)           as leads
from public.event_attendees a
where a.event_id = '6a848f55-c782-4a3f-b46e-ccb11d10eabf'
  and (
    (a.first_name ilike 'Ioan'   and a.last_name ilike 'Berintan')
    or (a.first_name ilike 'Lina'   and a.last_name ilike 'Mavzer')
    or (a.first_name ilike 'Arslan' and a.last_name ilike 'Khan')
  )
order by a.last_name;


-- ── Stap 1 — Ioan en Lina: de opvolgrij die er nooit kwam ───────────────────
-- Maakt per persoon één open event_followups-rij met reden 'onbekend' en een
-- belmoment van morgen. Slaat over wie er al een open rij heeft.
insert into public.event_followups
  (attendee_id, event_id, reason, reason_code, bron_uitkomst, follow_up_date, status, created_at)
select a.id,
       a.event_id,
       null,
       'onbekend',
       'no_show',
       (current_date + 1),
       'open',
       now()
from public.event_attendees a
where a.event_id = '6a848f55-c782-4a3f-b46e-ccb11d10eabf'
  and (   (a.first_name ilike 'Ioan' and a.last_name ilike 'Berintan')
       or (a.first_name ilike 'Lina' and a.last_name ilike 'Mavzer'))
  and not exists (
    select 1 from public.event_followups f
     where f.attendee_id = a.id and f.status = 'open'
  );


-- ── Stap 2 — Ioan en Lina: de belrij, met eerlijke notitie ──────────────────
-- Maakt per persoon één follow_up_leads-rij die morgen op de Werklijst staat.
-- De notitie zegt wat er werkelijk aan de hand is: er WAS een notitie, en die
-- is bij het afronden verloren gegaan.
insert into public.follow_up_leads
  (customer_id, source, lead_name, lead_email, lead_phone, lead_status,
   terugbel_datum, source_ref, created_at, updated_at)
select a.customer_id,
       'event',
       coalesce(nullif(trim(coalesce(a.first_name,'') || ' ' || coalesce(a.last_name,'')), ''),
                a.email, '(onbekend)'),
       a.email,
       a.phone,
       'nieuw',
       (current_date + 1)::timestamptz,
       jsonb_build_object(
         'event_id',          a.event_id,
         'attendee_id',       a.id,
         'is_event_followup', true,
         'event_uitkomst',    'no_show',
         'reason_code',       'onbekend',
         'reason',            'Er is op 26 augustus een notitie bij deze deelnemer getypt, maar die is bij het afronden verloren gegaan (zie reparatie 27-08). De inhoud is niet te achterhalen — vraag het na bij wie het event afrondde.',
         'hersteld_op',       now()
       ),
       now(),
       now()
from public.event_attendees a
where a.event_id = '6a848f55-c782-4a3f-b46e-ccb11d10eabf'
  and (   (a.first_name ilike 'Ioan' and a.last_name ilike 'Berintan')
       or (a.first_name ilike 'Lina' and a.last_name ilike 'Mavzer'))
  and not exists (
    select 1 from public.follow_up_leads l
     where l.source_ref->>'attendee_id' = a.id::text
  );


-- ── Stap 3 — Arslan: zijn gesloten belrij weer openzetten ───────────────────
-- Zet de bestaande rij van 'verloren' terug op 'terugbellen' met een belmoment
-- van morgen. `attempts` blijft staan: de eerdere belpogingen zijn historiek
-- en horen zichtbaar te blijven.
update public.follow_up_leads l
   set lead_status    = 'terugbellen',
       terugbel_datum = (current_date + 1)::timestamptz,
       updated_at     = now()
from public.event_attendees a
where a.event_id = '6a848f55-c782-4a3f-b46e-ccb11d10eabf'
  and a.first_name ilike 'Arslan' and a.last_name ilike 'Khan'
  and l.customer_id = a.customer_id
  and l.lead_status in ('verlengd', 'verloren');


-- ── Stap 4 — een spoor in het notitielog ────────────────────────────────────
-- Zodat niemand zich straks afvraagt waarom deze drie rijen bestaan of waarom
-- een verloren lead ineens weer op de lijst staat.
insert into public.follow_up_lead_notes (lead_id, note, created_at)
select l.id,
       'Handmatig hersteld op 27-08-2026 na het afronden van de masterclass van 26 augustus. Zie docs/sql-migrations/2026-08-27-reparatie-masterclass-26-aug.sql.',
       now()
from public.follow_up_leads l
join public.event_attendees a
  on a.id::text = l.source_ref->>'attendee_id'
 or (a.customer_id = l.customer_id and a.first_name ilike 'Arslan' and a.last_name ilike 'Khan')
where a.event_id = '6a848f55-c782-4a3f-b46e-ccb11d10eabf'
  and (   (a.first_name ilike 'Ioan'   and a.last_name ilike 'Berintan')
       or (a.first_name ilike 'Lina'   and a.last_name ilike 'Mavzer')
       or (a.first_name ilike 'Arslan' and a.last_name ilike 'Khan'))
  and not exists (
    select 1 from public.follow_up_lead_notes n
     where n.lead_id = l.id and n.note like 'Handmatig hersteld op 27-08-2026%'
  );


-- ── Stap 5 — controle ───────────────────────────────────────────────────────
-- Verwacht drie rijen, allemaal met een terugbel_datum van morgen en een
-- lead_status die NIET 'verlengd' of 'verloren' is.
select l.lead_name, l.lead_status, l.terugbel_datum, l.attempts,
       l.source_ref->>'event_uitkomst' as herkomst,
       l.source_ref->>'reason_code'    as reden,
       left(coalesce(l.source_ref->>'reason', ''), 60) as notitie_begin
from public.follow_up_leads l
join public.event_attendees a
  on a.id::text = l.source_ref->>'attendee_id' or a.customer_id = l.customer_id
where a.event_id = '6a848f55-c782-4a3f-b46e-ccb11d10eabf'
  and (   (a.first_name ilike 'Ioan'   and a.last_name ilike 'Berintan')
       or (a.first_name ilike 'Lina'   and a.last_name ilike 'Mavzer')
       or (a.first_name ilike 'Arslan' and a.last_name ilike 'Khan'))
order by l.lead_name;


-- ============================================================================
--  TERUGDRAAIEN
-- ============================================================================
--  Stap 1 en 2 (Ioan + Lina) zijn nieuwe rijen; die kun je weghalen:
--    delete from public.follow_up_leads
--     where source_ref->>'hersteld_op' is not null
--       and source_ref->>'event_id' = '6a848f55-c782-4a3f-b46e-ccb11d10eabf';
--    delete from public.event_followups
--     where event_id = '6a848f55-c782-4a3f-b46e-ccb11d10eabf'
--       and reason is null and reason_code = 'onbekend';
--
--  Stap 3 (Arslan) zet zijn rij terug op 'verloren' zonder belmoment:
--    (alleen doen als je zeker weet dat dat de oude toestand was)
--    update public.follow_up_leads set lead_status = 'verloren', terugbel_datum = null
--     where id = '<het-id-uit-stap-5>';
-- ============================================================================
