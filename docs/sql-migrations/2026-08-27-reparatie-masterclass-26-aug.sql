-- ============================================================================
--  REPARATIE — masterclass van 26 augustus 2026
--  event 6a848f55-c782-4a3f-b46e-ccb11d10eabf
--
--  VERSIE 3 — DEFINITIEF. Alleen Ioan en Lina. Alle vragen beantwoord.
--  Stap 0c is gedraaid en hoeft niet opnieuw; stap 1 t/m 4 kunnen achter
--  elkaar.
-- ============================================================================
--  WAT ER IN VERSIE 2 NOG NIET KLOPTE
--  ----------------------------------
--  Stap 0b liet zien dat de werkelijkheid opnieuw anders is:
--
--    Arslan Khan    terugbellen · 01-10-2026 · afgemeld/onbekend · attempts 0
--    Ioan Berintan  verlengd    · geen datum · geen herkomst     · attempts 0
--    Lina Mavzer    verlengd    · geen datum · geen herkomst     · attempts 0
--
--  ARSLAN WORDT NIET MEER AANGERAAKT. Bij hem is niets stukgegaan: hij staat
--  op 'terugbellen' met een belmoment van 1 oktober en herkomst 'afgemeld',
--  reden 'onbekend'. Dat is precies wat het nieuwe afrondscherm wegschrijft —
--  'Onbekend' is een van de vier aanklikbare redenen. Hij staat ver vooruit
--  gepland, niet kwijt. Hem "heropenen" zou een bewuste afspraak overschrijven.
--
--  WAAROM IOAN EN LINA OP 'VERLENGD' STAAN
--  ---------------------------------------
--  Dat is niet "gewonnen". Het is de belronde van vóór het event.
--  api/follow-up-lead-outcome.js regel 730-741: de uitkomst 'bevestigd' —
--  iemand zegt telefonisch dat hij komt — zet lead_status op 'verlengd' en
--  terugbel_datum op NULL. In de woordenschat van die ronde betekent dat
--  "afgehandeld, hij komt"; het woord 'verlengd' is geleend van de retentie-
--  kant, waar het wél omzet betekent.
--
--  Hier is het dus een VERKEERD ETIKET, geen waarde die je kwijtraakt. Ze
--  hebben bevestigd dat ze zouden komen, en zijn toen niet gekomen — dat is
--  het tegenovergestelde van gewonnen.
--
--  De oude status wordt tóch bewaard: in source_ref als `vorige_lead_status`
--  en in het notitielog. Niet omdat hij waarde heeft, maar omdat ik in deze
--  reparatie al twee keer een aanname fout had en dit niets kost.
--
--  DE NOTITIE IS GERECONSTRUEERD, NIET HERSTELD
--  --------------------------------------------
--  De originele notitie van 26 augustus is weg; die is nooit de browser uit
--  gekomen. Wat er komt te staan is wat Maxim zich op 27 augustus herinnerde.
--  Dat staat er zelf bij, en als los veld (notitie_herkomst).
--
--  IDEMPOTENT. Elke schrijvende stap slaat zichzelf over als hij al gedraaid
--  is. Er wordt niets verwijderd.
--
--  WAT ELKE STAP VERANDERT — in één regel per stap:
--    0c  niets — al gedraaid en beantwoord, overslaan
--    1   maakt twee event_followups-rijen aan, één voor Ioan en één voor Lina
--    2   zet die twee leads op 'terugbellen' met een belmoment van morgen,
--        vult herkomst/reden/notitie aan en bewaart de oude status
--    3   schrijft één notitieregel per lead over deze reparatie
--    4   niets (controle: staan ze nu echt op de Werklijst?)
-- ============================================================================


-- ── Stap 0c — AL GEDRAAID EN BEANTWOORD, overslaan ──────────────────────────
-- De vraag was: waarom staat `event_date` wel in Lina's source_ref en niet in
-- die van Ioan, terwijl ze op hetzelfde event stonden?
--
-- HET ANTWOORD (gemeten 27-08-2026): ze zijn op een andere manier ontstaan.
--   · Ioan  — 17-08 om 13:57, door een MENS aangemaakt (created_by_user_id
--             gevuld), met een kale source_ref: alleen event_id, attendee_id
--             en is_event_followup. Hij is met de hand toegevoegd, een week
--             vóór de belronde-cron hem zou oppakken. Vandaar geen event_date.
--   · Lina  — 24-08 om 07:01, door de cron (created_by_user_id NULL), met
--             reason 'auto_belronde_2d', event_date en event_title erbij.
-- Allebei voor het laatst bijgewerkt op 24-08 in de namiddag, toen ze
-- bevestigden dat ze zouden komen.
--
-- Er is dus niets vreemds met Ioans rij gebeurd; hij is simpelweg ouder en
-- handmatig. Het verschil raakt de reparatie niet: stap 2 gebruikt de `-`
-- operator op `event_date` en die doet niets als de sleutel er al niet is.
--
-- De query hieronder staat er alleen nog als naslag. Overslaan.
select l.lead_name,
       l.source,
       l.lead_kind,
       l.created_at,
       l.updated_at,
       l.created_by_user_id,
       jsonb_pretty(l.source_ref) as source_ref_volledig
from public.follow_up_leads l
where l.source_ref->>'attendee_id' in (
        '2dcf551a-7ee9-48f0-b241-e0a9f5f35703',   -- Ioan Berintan
        'b2198275-9771-4557-b72f-61a2f32a905f'    -- Lina Mavzer
      )
order by l.lead_name;


-- ── Stap 1 — de opvolgrij die er nooit kwam ─────────────────────────────────
-- VERANDERT: voegt twee rijen toe aan event_followups (Ioan, Lina). Raakt de
-- bellijst niet; dit is het dossier van het event zelf.
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


-- ── Stap 2 — de twee belrijen weer op de lijst ──────────────────────────────
-- VERANDERT, per rij:
--   lead_status     'verlengd'  →  'terugbellen'
--   terugbel_datum  NULL        →  morgen
--   source_ref      krijgt herkomst 'no_show', reden 'onbekend', de
--                   gereconstrueerde notitie, en `vorige_lead_status` met de
--                   oude waarde erin. Bestaande sleutels blijven staan;
--                   alleen `event_date` gaat eruit (zie hieronder).
--   attempts        ONGEMOEID (staat op 0, en dat klopt: ze zijn nooit
--                   vergeefs gebeld, ze hebben bevestigd en kwamen niet).
--
-- Waarom `event_date` eruit moet: staat die erin, dan herkent
-- follow-up-lead-outcome.js de rij als de bel-vóór-het-event-ronde en gebruikt
-- een cadans met de eventdatum als deadline. Die ligt in het verleden, dus bij
-- de eerste "geen gehoor" zou de rij meteen op 'niet_bereikbaar' gaan met een
-- lege datum — binnen één belpoging weer onzichtbaar.
update public.follow_up_leads l
   set lead_status    = 'terugbellen',
       terugbel_datum = (current_date + 1)::timestamptz,
       source_ref     = (coalesce(l.source_ref, '{}'::jsonb) - 'event_date') || jsonb_build_object(
         'event_id',            '6a848f55-c782-4a3f-b46e-ccb11d10eabf',
         'is_event_followup',   true,
         'event_uitkomst',      'no_show',
         'reason_code',         'onbekend',
         'reason',              'Warme lead die niet kwam opdagen, gratis lead voor volgend event. — Achteraf gereconstrueerd door Maxim op 27-08-2026; de originele notitie van 26-08 ging verloren bij het afronden.',
         'notitie_herkomst',    'gereconstrueerd',
         'gereconstrueerd_op',  '2026-08-27',
         'gereconstrueerd_door','Maxim',
         'vorige_lead_status',  l.lead_status,
         'hersteld_op',         now()
       ),
       updated_at = now()
where l.source_ref->>'attendee_id' in (
        '2dcf551a-7ee9-48f0-b241-e0a9f5f35703',
        'b2198275-9771-4557-b72f-61a2f32a905f'
      )
  and coalesce(l.source_ref->>'hersteld_op', '') = '';   -- idempotent


-- ── Stap 3 — een spoor in het notitielog ────────────────────────────────────
-- VERANDERT: voegt één notitieregel toe per lead (twee in totaal).
insert into public.follow_up_lead_notes (lead_id, note, created_at)
select l.id,
       'Handmatig op de bellijst gezet op 27-08-2026. Stond op ''verlengd'' zonder belmoment: dat kwam van de belronde vóór het event (uitkomst ''bevestigd'' = hij komt), niet van een gewonnen klant. Bevestigd en toen niet gekomen. De notitie hierbij is een reconstructie van Maxim, niet de originele tekst van 26-08 — die ging verloren bij het afronden. Zie docs/sql-migrations/2026-08-27-reparatie-masterclass-26-aug.sql.',
       now()
from public.follow_up_leads l
where l.source_ref->>'attendee_id' in (
        '2dcf551a-7ee9-48f0-b241-e0a9f5f35703',
        'b2198275-9771-4557-b72f-61a2f32a905f'
      )
  and not exists (
    select 1 from public.follow_up_lead_notes n
     where n.lead_id = l.id and n.note like 'Handmatig op de bellijst gezet op 27-08-2026%'
  );


-- ── Stap 4 — de enige controle die telt ─────────────────────────────────────
-- Spiegelt de filters van de Werklijst. Verwacht TWEE rijen (Ioan en Lina),
-- allebei met in_werklijst = true en van_belronde = false.
-- Staat er ergens false bij in_werklijst, dan is de reparatie niet gelukt —
-- hoe de rest er ook uitziet.
select l.lead_name,
       l.lead_status,
       l.terugbel_datum,
       l.attempts,
       (l.source_ref ? 'event_date')      as van_belronde,
       l.source_ref->>'event_uitkomst'    as herkomst,
       l.source_ref->>'vorige_lead_status' as vorige_status,
       (l.lead_status not in ('verlengd', 'verloren')
        and l.terugbel_datum is not null
        and l.terugbel_datum >= date_trunc('day', now())
        and (l.snoozed_until is null or l.snoozed_until <= now())) as in_werklijst
from public.follow_up_leads l
where l.source_ref->>'attendee_id' in (
        '2dcf551a-7ee9-48f0-b241-e0a9f5f35703',
        'b2198275-9771-4557-b72f-61a2f32a905f'
      )
order by l.lead_name;


-- ============================================================================
--  TERUGDRAAIEN
-- ============================================================================
--  De oude status staat in source_ref->>'vorige_lead_status', dus dit kan
--  volledig terug:
--
--    update public.follow_up_leads
--       set lead_status    = source_ref->>'vorige_lead_status',
--           terugbel_datum = null,
--           source_ref     = source_ref - 'hersteld_op' - 'vorige_lead_status'
--                                       - 'event_uitkomst' - 'reason_code'
--                                       - 'reason' - 'notitie_herkomst'
--                                       - 'gereconstrueerd_op'
--                                       - 'gereconstrueerd_door'
--     where source_ref->>'attendee_id' in (
--             '2dcf551a-7ee9-48f0-b241-e0a9f5f35703',
--             'b2198275-9771-4557-b72f-61a2f32a905f')
--       and source_ref->>'vorige_lead_status' is not null;
--
--    delete from public.event_followups
--     where attendee_id in ('2dcf551a-7ee9-48f0-b241-e0a9f5f35703',
--                           'b2198275-9771-4557-b72f-61a2f32a905f')
--       and reason_code = 'onbekend' and status = 'open';
--
--  LET OP: `event_date` komt hiermee NIET terug bij Lina. Die waarde staat in
--  de uitvoer van stap 0b/0c — bewaar die als je hem nodig zou hebben.
-- ============================================================================
