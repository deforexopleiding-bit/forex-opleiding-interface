-- ============================================================================
--  REPARATIE — masterclass van 26 augustus 2026
--  event 6a848f55-c782-4a3f-b46e-ccb11d10eabf
--
--  VERSIE 2 — herschreven op 27-08-2026 na het draaien van stap 0.
-- ============================================================================
--  WAAROM ER EEN VERSIE 2 IS
--  -------------------------
--  Versie 1 stond op twee aannames die alle twee onjuist waren, en het
--  vervelende is dat hij er wél uit zou hebben gezien alsof hij gelukt was:
--
--   1. Ik nam aan dat Ioan en Lina GEEN belrij hadden. Ze hebben er alle
--      drie één, gekoppeld op source_ref->>'attendee_id' — vrijwel zeker van
--      de belronde-cron van twee dagen vóór het event. Versie 1 wilde een
--      nieuwe rij invoegen en sloeg ze daardoor over ("bestaat al").
--   2. Ik nam aan dat er een customer_id was. Die is bij alle drie NULL.
--      Versie 1 koppelde Arslan op `l.customer_id = a.customer_id`, en NULL
--      is in SQL nooit gelijk aan NULL — die stap zou stilzwijgend nul rijen
--      hebben geraakt.
--
--  Netto had versie 1 twee opvolgrijen en wat notities opgeleverd, zou er nog
--  steeds niemand op de bellijst hebben gestaan, en zou de controlequery
--  waarschijnlijk toch drie rijen hebben getoond. Precies de stille mislukking
--  waar deze hele ronde over ging.
--
--  WAT DE SITUATIE ECHT IS (gemeten 27-08-2026)
--  --------------------------------------------
--    Ioan Berintan   2dcf551a-…  no_show    · 0 opvolgrijen · 1 belrij
--    Lina Mavzer     b2198275-…  no_show    · 0 opvolgrijen · 1 belrij
--    Arslan Khan     aecaa26d-…  afgemeld   · 1 opvolgrij   · 1 belrij
--    customer_id: NULL bij alle drie. outcome: NULL bij alle drie.
--
--  Het is dus voor alle drie hetzelfde geval: er IS een belrij, hij staat
--  alleen niet op een manier waarop iemand hem ziet. Heropenen dus, niet
--  aanmaken. En koppelen op attendee_id, niet op customer_id.
--
--  LET OP — event_date MOET UIT source_ref
--  ---------------------------------------
--  Komt een rij van de belronde-cron, dan staat er `event_date` in source_ref.
--  api/follow-up-lead-outcome.js herkent dáéraan de bel-vóór-het-event-ronde
--  en gebruikt dan een cadans met de eventdatum als deadline. Die datum ligt
--  nu in het verleden, dus bij de eerstvolgende "geen gehoor" zou de rij
--  meteen op 'niet_bereikbaar' worden gezet met terugbel_datum leeg — en dan
--  is hij opnieuw onzichtbaar. Stap 2 haalt die sleutel daarom weg: het event
--  is voorbij, dit zijn vanaf nu gewone opvolg-leads met de cadans van vijf.
--
--  DE NOTITIE IS GERECONSTRUEERD, NIET HERSTELD
--  --------------------------------------------
--  De originele notitie van 26 augustus is weg; die is nooit de browser uit
--  gekomen. Wat er bij Ioan en Lina komt te staan is wat Maxim zich op 27
--  augustus herinnerde. Dat staat er ook zelf bij, en als los veld
--  (notitie_herkomst='gereconstrueerd'). Arslan houdt zijn eigen notitie —
--  bij hem is die wél netjes opgeslagen, dus daar wordt niets overschreven.
--
--  IDEMPOTENT. Elke stap kijkt of het werk al gedaan is. Twee keer draaien
--  verandert niets extra. Er wordt niets verwijderd.
--
--  ── DRAAIEN ────────────────────────────────────────────────────────────────
--  Stap voor stap in de Supabase SQL-editor. Draai 0a en 0b eerst en lees ze
--  écht — de vorige versie strandde precies daarop.
-- ============================================================================


-- ── Stap 0a — bestaan de kolommen die stap 0b en 2 gebruiken? ───────────────
-- `attempts` en `snoozed_until` zitten in de groep waarvan de code zelf niet
-- zeker weet of ze bestaan (van follow_up_leads is geen migratie in de repo).
-- Verwacht: beide aanwezig. Ontbreekt er één, MELD DAT — dan haal ik hem uit
-- stap 0b en stap 2, want anders faalt de query.
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'follow_up_leads'
  and column_name in ('attempts', 'snoozed_until', 'lead_status', 'terugbel_datum', 'source_ref')
order by column_name;


-- ── Stap 0b — hoe staan die drie belrijen er NU bij? ────────────────────────
-- Dit is wat we nog niet wisten en wat bepaalt wat "heropenen" betekent.
-- Verwacht: drie rijen. Kijk naar lead_status, terugbel_datum en attempts,
-- en naar of er `event_date` in source_ref staat (dan is het een belronde-rij).
select l.id                                as lead_id,
       l.lead_name,
       l.lead_status,
       l.terugbel_datum,
       l.attempts,
       l.snoozed_until,
       (l.source_ref ? 'event_date')       as van_belronde,
       l.source_ref->>'event_uitkomst'     as herkomst,
       l.source_ref->>'reason_code'        as reden,
       left(coalesce(l.source_ref->>'reason', '(geen)'), 70) as notitie
from public.follow_up_leads l
where l.source_ref->>'attendee_id' in (
        '2dcf551a-7ee9-48f0-b241-e0a9f5f35703',   -- Ioan Berintan
        'b2198275-9771-4557-b72f-61a2f32a905f',   -- Lina Mavzer
        'aecaa26d-4910-421a-a08a-867ea76bd49a'    -- Arslan Khan
      )
order by l.lead_name;


-- ── Stap 1 — Ioan en Lina: de opvolgrij die er nooit kwam ───────────────────
-- Arslan heeft er al één (open_followups = 1) en wordt overgeslagen.
-- Raakt de bellijst niet; dit is het dossier van het event zelf.
insert into public.event_followups
  (attendee_id, event_id, reason, reason_code, bron_uitkomst, follow_up_date, status, created_at)
select a.id,
       a.event_id,
       'Warme lead die niet kwam opdagen, gratis lead voor volgend event. — Achteraf gereconstrueerd door Maxim op 27-08-2026; de originele notitie van 26-08 ging verloren bij het afronden.',
       'onbekend',
       'no_show',
       (current_date + 1),
       'open',
       now()
from public.event_attendees a
where a.id in (
        '2dcf551a-7ee9-48f0-b241-e0a9f5f35703',
        'b2198275-9771-4557-b72f-61a2f32a905f'
      )
  and not exists (
    select 1 from public.event_followups f
     where f.attendee_id = a.id and f.status = 'open'
  );


-- ── Stap 2a — Ioan en Lina: hun belrij weer zichtbaar maken ─────────────────
-- Heropenen, niet aanmaken. Wat er gebeurt:
--   · lead_status  → 'terugbellen', maar ALLEEN als hij afgesloten of
--                    onbereikbaar stond. Staat hij al open, dan blijft hij.
--   · terugbel_datum → morgen, maar ALLEEN als hij leeg is of in het verleden
--                    ligt. Een afspraak in de toekomst wordt niet overschreven.
--   · attempts     → ONGEMOEID. Eerdere belpogingen zijn historiek.
--   · source_ref   → samengevoegd, niet vervangen: bestaande sleutels blijven,
--                    `event_date` gaat eruit (zie de kop), en de event-context
--                    plus de gereconstrueerde notitie komen erbij.
update public.follow_up_leads l
   set lead_status = case
         when l.lead_status in ('verlengd', 'verloren', 'niet_bereikbaar') then 'terugbellen'
         else l.lead_status
       end,
       terugbel_datum = case
         when l.terugbel_datum is null or l.terugbel_datum < now() then (current_date + 1)::timestamptz
         else l.terugbel_datum
       end,
       source_ref = (coalesce(l.source_ref, '{}'::jsonb) - 'event_date') || jsonb_build_object(
         'event_id',            '6a848f55-c782-4a3f-b46e-ccb11d10eabf',
         'is_event_followup',   true,
         'event_uitkomst',      'no_show',
         'reason_code',         'onbekend',
         'reason',              'Warme lead die niet kwam opdagen, gratis lead voor volgend event. — Achteraf gereconstrueerd door Maxim op 27-08-2026; de originele notitie van 26-08 ging verloren bij het afronden.',
         'notitie_herkomst',    'gereconstrueerd',
         'gereconstrueerd_op',  '2026-08-27',
         'gereconstrueerd_door','Maxim',
         'hersteld_op',         now()
       ),
       updated_at = now()
where l.source_ref->>'attendee_id' in (
        '2dcf551a-7ee9-48f0-b241-e0a9f5f35703',
        'b2198275-9771-4557-b72f-61a2f32a905f'
      )
  and coalesce(l.source_ref->>'hersteld_op', '') = '';   -- idempotent


-- ── Stap 2b — Arslan: zelfde behandeling, maar zijn notitie blijft ──────────
-- Bij hem is het afronden wél goed gegaan en staat er een echte notitie.
-- Die wordt niet overschreven; alleen zichtbaarheid en herkomst worden gezet.
-- Hij was AFGEMELD (niet no-show), dus de herkomst is 'afgemeld'.
update public.follow_up_leads l
   set lead_status = case
         when l.lead_status in ('verlengd', 'verloren', 'niet_bereikbaar') then 'terugbellen'
         else l.lead_status
       end,
       terugbel_datum = case
         when l.terugbel_datum is null or l.terugbel_datum < now() then (current_date + 1)::timestamptz
         else l.terugbel_datum
       end,
       source_ref = (coalesce(l.source_ref, '{}'::jsonb) - 'event_date') || jsonb_build_object(
         'event_id',          '6a848f55-c782-4a3f-b46e-ccb11d10eabf',
         'is_event_followup', true,
         'event_uitkomst',    'afgemeld',
         'hersteld_op',       now()
       ),
       updated_at = now()
where l.source_ref->>'attendee_id' = 'aecaa26d-4910-421a-a08a-867ea76bd49a'
  and coalesce(l.source_ref->>'hersteld_op', '') = '';   -- idempotent


-- ── Stap 2c — sluimering opheffen (alleen als de kolom bestaat) ─────────────
-- Sla deze over als stap 0a `snoozed_until` niet toonde. Een sluimerende rij
-- blijft anders ondanks alles onzichtbaar.
update public.follow_up_leads l
   set snoozed_until = null
where l.source_ref->>'attendee_id' in (
        '2dcf551a-7ee9-48f0-b241-e0a9f5f35703',
        'b2198275-9771-4557-b72f-61a2f32a905f',
        'aecaa26d-4910-421a-a08a-867ea76bd49a'
      )
  and l.snoozed_until is not null;


-- ── Stap 3 — een spoor in het notitielog ────────────────────────────────────
-- Zodat niemand zich later afvraagt waarom deze rijen ineens weer leven.
insert into public.follow_up_lead_notes (lead_id, note, created_at)
select l.id,
       'Handmatig heropend op 27-08-2026 na het afronden van de masterclass van 26 augustus. De belrij stond niet op een lijst; eerdere belpogingen zijn behouden. Bij Ioan en Lina is de notitie een reconstructie van Maxim, niet de originele tekst van 26-08 — die ging verloren. Zie docs/sql-migrations/2026-08-27-reparatie-masterclass-26-aug.sql.',
       now()
from public.follow_up_leads l
where l.source_ref->>'attendee_id' in (
        '2dcf551a-7ee9-48f0-b241-e0a9f5f35703',
        'b2198275-9771-4557-b72f-61a2f32a905f',
        'aecaa26d-4910-421a-a08a-867ea76bd49a'
      )
  and not exists (
    select 1 from public.follow_up_lead_notes n
     where n.lead_id = l.id and n.note like 'Handmatig heropend op 27-08-2026%'
  );


-- ── Stap 4 — controle ───────────────────────────────────────────────────────
-- Verwacht drie rijen, en let op ALLE DRIE deze dingen:
--   · lead_status is NIET 'verlengd', 'verloren' of 'niet_bereikbaar'
--   · terugbel_datum is gevuld en ligt vandaag of later
--   · van_belronde is false  (event_date is eruit)
-- Klopt er één niet, dan staat die persoon nog steeds niet op de bellijst.
select l.lead_name,
       l.lead_status,
       l.terugbel_datum,
       l.attempts,
       (l.source_ref ? 'event_date')    as van_belronde,
       l.source_ref->>'event_uitkomst'  as herkomst,
       l.source_ref->>'notitie_herkomst' as notitie_herkomst,
       left(coalesce(l.source_ref->>'reason', '(geen)'), 70) as notitie
from public.follow_up_leads l
where l.source_ref->>'attendee_id' in (
        '2dcf551a-7ee9-48f0-b241-e0a9f5f35703',
        'b2198275-9771-4557-b72f-61a2f32a905f',
        'aecaa26d-4910-421a-a08a-867ea76bd49a'
      )
order by l.lead_name;


-- ── Stap 5 — de echte proef ─────────────────────────────────────────────────
-- Staan ze nu ook daadwerkelijk in de emmers van de Werklijst? Dit spiegelt
-- de filters uit api/follow-up-leads-list.js. Verwacht drie rijen met
-- in_werklijst = true. Dit is de enige controle die telt: stap 4 kan er goed
-- uitzien terwijl de lijst leeg blijft.
select l.lead_name,
       l.lead_status,
       l.terugbel_datum,
       (l.lead_status not in ('verlengd', 'verloren')
        and l.terugbel_datum is not null
        and (l.snoozed_until is null or l.snoozed_until <= now())) as in_werklijst
from public.follow_up_leads l
where l.source_ref->>'attendee_id' in (
        '2dcf551a-7ee9-48f0-b241-e0a9f5f35703',
        'b2198275-9771-4557-b72f-61a2f32a905f',
        'aecaa26d-4910-421a-a08a-867ea76bd49a'
      )
order by l.lead_name;


-- ============================================================================
--  TERUGDRAAIEN
-- ============================================================================
--  Er wordt niets verwijderd, dus terugdraaien is alleen nodig als je de
--  heropening ongedaan wilt maken. Noteer eerst de uitvoer van stap 0b — dat
--  is de enige plek waar de oude waarden staan.
--
--    -- de opvolgrijen van stap 1 weghalen:
--    delete from public.event_followups
--     where attendee_id in ('2dcf551a-7ee9-48f0-b241-e0a9f5f35703',
--                           'b2198275-9771-4557-b72f-61a2f32a905f')
--       and reason_code = 'onbekend' and status = 'open';
--
--    -- de markering weghalen zodat stap 2 opnieuw kan draaien:
--    update public.follow_up_leads
--       set source_ref = source_ref - 'hersteld_op'
--     where source_ref->>'attendee_id' in (...);
--
--    -- lead_status en terugbel_datum terugzetten: handmatig, met de waarden
--    -- uit stap 0b. Er is geen automatische weg terug.
-- ============================================================================
