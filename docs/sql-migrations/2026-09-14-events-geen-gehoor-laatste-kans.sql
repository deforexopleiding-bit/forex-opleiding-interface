-- 2026-09-14 — GEEN GEHOOR: LAATSTE KANS
--
-- ══════════════════════════════════════════════════════════════════════════
--  WAT DIT DOET
-- ══════════════════════════════════════════════════════════════════════════
--
--  STAP 1  CHECK op event_automations.trigger_type uitbreiden met
--          'on_call_status'. BLOKKEREND: zonder deze stap weigert Postgres
--          elke automatisatie met de nieuwe trigger (23514), ook al laat de
--          app-validatie in api/events-automation-save.js hem door.
--
--  STAP 2  Nieuwe automatisatie 'Geen gehoor - laatste kans', enabled = FALSE.
--          Vijf stappen: mail met deadline → 48 uur wachten (maar nooit later
--          dan 48 uur vóór het event) → controleren of er niets binnenkwam →
--          inschrijving annuleren + belstatus komt_niet → melding aan Maxim.
--
--  STAP 3  De voorwaarde ook in de BESTAANDE welkomstmail ('Welkom +
--          vragenlijst', stap 0).
--
--  STAP 4  Idem in de bevestigingsmail ('Bevestiging aanmelding', stap 0).
--
--  STAP 5  Verificatie.
--
-- ══════════════════════════════════════════════════════════════════════════
--  DE REGEL DIE HIERACHTER ZIT (Maxims beslissingen, 14 september)
-- ══════════════════════════════════════════════════════════════════════════
--
--  1. Een plek is pas definitief nadat we de deelnemer telefonisch gesproken
--     hebben. Die voorwaarde wordt VOORAF gecommuniceerd — daarom stap 3 en 4.
--  2. Geen gehoor betekent: mail met een deadline, en zonder reactie vervalt
--     de plek.
--  3. De deadline is 48 uur, maar nooit later dan 48 uur vóór het event.
--  4. Dit geldt ook voor wie nu al ingeschreven staat, maar PAS nadat die mail
--     met deadline verstuurd is. Daarom enroll_mode 'new_only' met de grens op
--     call_status_at: de 15 rijen die op 14 september al op geen_gehoor
--     stonden worden NIET met terugwerkende kracht ingeschreven. Wie van hen
--     alsnog mee moet, krijgt eerst een nieuwe belronde en dus een nieuwe
--     call_status_at.
--  5. De knop in Opvolging mag pas gebruikt worden als de archiveerdrempel
--     gehaald is (3 belpogingen op 3 verschillende dagen + 1 WhatsApp). Dat
--     zit in de UI, niet in deze migratie.
--  6. De mail gaat nu live; de WhatsApp-stap komt erbij zodra Meta de template
--     goedkeurt. Zie 'DE WHATSAPP-STAP' onderaan.
--
-- ══════════════════════════════════════════════════════════════════════════
--  LET OP — steps_snapshot WORDT BEVROREN BIJ INSCHRIJVING
-- ══════════════════════════════════════════════════════════════════════════
--  event_automation_runs.steps_snapshot is een kopie van `steps` op het moment
--  dat iemand ingeschreven wordt. Wie al loopt houdt dus zijn EIGEN versie van
--  de stappen: een wijziging aan de automatisatie (of aan de teksten hieronder)
--  raakt alleen mensen die daarna ingeschreven worden. Dat is met opzet — een
--  lopende deadline mag niet halverwege van vorm veranderen — maar het betekent
--  ook dat een fout in de tekst niet met een UPDATE te repareren is voor wie al
--  onderweg is. Voor die gevallen: run cancellen en opnieuw inschrijven.
--
-- ══════════════════════════════════════════════════════════════════════════
--  VEILIGHEID
-- ══════════════════════════════════════════════════════════════════════════
--  · Stap 1 is een CHECK-uitbreiding: bestaande waarden blijven geldig.
--  · Stap 2 maakt de automatisatie UIT aan. Er gebeurt niets tot iemand hem in
--    de eventmodule aanzet.
--  · Stap 3 en 4 zijn IDEMPOTENT en APPEND-ONLY: ze voegen één alinea toe en
--    doen niets als die alinea er al staat. De bestaande tekst wordt niet
--    herschreven.
--  · Elke UPDATE heeft een SELECT ervóór die de HUIDIGE tekst toont én een
--    voorbeeld van de nieuwe tekst. Dit is productietekst die klanten lezen —
--    lees die twee eerst naast elkaar.
--  · Elk statement staat los. De Supabase SQL-editor knipt input op
--    statement-grenzen (elk statement een eigen transactie), dus geen TEMP
--    TABLE en geen DO-block dat state van een ander block verwacht — zie de
--    lesson learned van 2026-07-17.
--
--  Rollback:
--    STAP 2 → DELETE FROM event_automations WHERE name = 'Geen gehoor - laatste kans';
--    STAP 3/4 → de omgekeerde replace(), zie de rollback-regels daar.
--    STAP 1 → alleen terugdraaien als er geen on_call_status-rijen meer zijn.


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 0 — PREFLIGHT. Draai deze drie SELECTs en lees ze voordat je verder
--          gaat. Ze schrijven niets.
-- ══════════════════════════════════════════════════════════════════════════

-- 0a · Bestaat de automatisatie al? (herhaalde run → deze migratie slaat
--      stap 2 dan over)
-- SELECT id, name, enabled, enabled_at, trigger_type, trigger_config,
--        scope_type, scope_config, enroll_mode, jsonb_array_length(steps) AS n_steps
--   FROM event_automations
--  WHERE trigger_type = 'on_call_status' OR name = 'Geen gehoor - laatste kans';

-- 0b · Welke niveau-slugs bestaan er? Stap 2 zoekt de masterclass-slug hier op
--      en stopt met een foutmelding als hij hem niet vindt.
-- SELECT slug, label, sort_order, is_active FROM event_niveau_options ORDER BY sort_order, label;

-- 0c · Hoeveel deelnemers staan er NU op geen_gehoor, en met welke
--      call_status_at? Dit is de groep die door enroll_mode 'new_only' BUITEN
--      de flow blijft. Op 14 september waren dit 15 rijen.
-- SELECT a.call_status, count(*) AS aantal,
--        count(*) FILTER (WHERE a.call_status_at IS NULL) AS zonder_tijdstip,
--        min(a.call_status_at) AS oudste, max(a.call_status_at) AS nieuwste
--   FROM event_attendees a
--   JOIN events e ON e.id = a.event_id
--  WHERE a.status = 'aangemeld' AND e.starts_at > now()
--  GROUP BY a.call_status ORDER BY aantal DESC;


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 1 — CHECK op trigger_type uitbreiden. BLOKKEREND.
-- ══════════════════════════════════════════════════════════════════════════
-- Zonder deze stap faalt stap 2 met 23514, en faalt ook elke poging om de
-- automatisatie via de UI te bewaren.

ALTER TABLE public.event_automations
  DROP CONSTRAINT IF EXISTS event_automations_trigger_type_check;

ALTER TABLE public.event_automations
  ADD CONSTRAINT event_automations_trigger_type_check
  CHECK (trigger_type IN (
    'on_signup',
    'on_assessment_completed',
    'time_before_event',
    'on_assessment_not_completed_after',
    'on_call_status'
  ));

COMMENT ON COLUMN public.event_automations.trigger_type IS
  'on_signup | on_assessment_completed | time_before_event | on_assessment_not_completed_after | on_call_status. '
  'on_call_status leest trigger_config.call_status en start zodra event_attendees.call_status daarop staat; '
  'enroll_mode new_only toetst dan op call_status_at (niet op registered_at).';


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 2 — DE AUTOMATISATIE. enabled = FALSE.
-- ══════════════════════════════════════════════════════════════════════════
--
-- Eén DO-block, want de niveau-slug moet eerst opgezocht worden en er mag
-- NIETS geschreven worden als die niet bestaat. Vindt hij geen masterclass-
-- slug, dan stopt hij met een foutmelding die de beschikbare slugs opsomt —
-- liever een duidelijke fout dan een automatisatie die op een niveau staat dat
-- niemand gebruikt en dus nooit iemand pakt.
--
-- Idempotent: bestaat de rij al (op naam), dan doet dit block niets.

DO $$
DECLARE
  v_niveau  text;
  v_slugs   text;
  v_bestaat uuid;
BEGIN
  SELECT id INTO v_bestaat FROM public.event_automations
   WHERE name = 'Geen gehoor - laatste kans' LIMIT 1;
  IF v_bestaat IS NOT NULL THEN
    RAISE NOTICE 'Automatisatie bestaat al (%). Niets gedaan.', v_bestaat;
    RETURN;
  END IF;

  SELECT slug INTO v_niveau
    FROM public.event_niveau_options
   WHERE is_active AND slug ILIKE '%masterclass%'
   ORDER BY sort_order, label
   LIMIT 1;

  IF v_niveau IS NULL THEN
    SELECT string_agg(slug, ', ' ORDER BY sort_order, label) INTO v_slugs
      FROM public.event_niveau_options WHERE is_active;
    RAISE EXCEPTION
      'Geen actief niveau met "masterclass" in de slug. Beschikbaar: %. Zet het juiste niveau met de hand in dit block, of gebruik scope_type ''events'' met de losse event-ids.',
      coalesce(v_slugs, '(geen actieve niveaus)');
  END IF;

  INSERT INTO public.event_automations
    (name, description, enabled, enabled_at, trigger_type, trigger_config,
     scope_type, scope_config, enroll_mode, steps)
  VALUES (
    'Geen gehoor - laatste kans',
    'Start zodra de belstatus op geen_gehoor gaat (knop in Opvolging, na 3 belpogingen op 3 dagen + 1 WhatsApp). '
    || 'Mail met deadline van 48 uur (nooit later dan 48u voor het event); geen reactie = plek vervalt + melding aan Maxim. '
    || 'De WhatsApp-stap komt tussen stap 0 en 1 zodra de Meta-template goedgekeurd is.',
    false,      -- UIT. Aanzetten gebeurt in de eventmodule, niet hier.
    null,       -- enabled_at wordt gezet op het moment van aanzetten; dat is
                -- ook de grens waarop enroll_mode 'new_only' toetst.
    'on_call_status',
    jsonb_build_object('call_status', 'geen_gehoor'),
    'niveau',
    jsonb_build_object('niveau', v_niveau),
    'new_only', -- ZIE BESLISSING 4. Zonder dit worden de 15 bestaande
                -- geen_gehoor-rijen bij het aanzetten meteen ingeschreven.
    jsonb_build_array(

      -- ── STAP 0 · DE MAIL MET DE DEADLINE ──────────────────────────────
      -- {{event.locatie}} en niet 'Gent': deze automatisatie hangt aan een
      -- NIVEAU, dus hij pakt elke masterclass. Een vaste stad zou 'in Gent'
      -- schrijven in een mail over Antwerpen. Voor het event van 26/09 in Gent
      -- rendert dit letterlijk 'in Gent'.
      -- {{attendee.geen_gehoor_deadline}} rekent 48 uur vanaf call_status_at
      -- met dezelfde bovengrens als de wachtstap hieronder — één definitie, in
      -- api/_lib/geen-gehoor-deadline.js.
      jsonb_build_object(
        'type', 'send_email',
        'config', jsonb_build_object(
          'subject', 'Je plek voor de Forex Masterclass - we hebben je niet kunnen bereiken',
          'body',
            'Beste {{attendee.voornaam}},' || chr(10) || chr(10) ||
            'je hebt je ingeschreven voor de Forex Masterclass van {{event.datum}} in {{event.locatie}}. '
            || 'We hebben je de afgelopen dagen meermaals telefonisch proberen te bereiken om je deelname te bevestigen. '
            || 'Dat is ons niet gelukt.' || chr(10) || chr(10) ||
            'Waarom we daarvoor bellen: de zaal heeft een beperkt aantal plaatsen en de deelname is gratis. '
            || 'Elke plek die bezet blijft door iemand die niet komt, is een plek die we niet aan iemand anders kunnen geven. '
            || 'Daarom bevestigen we elke deelnemer persoonlijk. Daar maken we geen uitzonderingen op - niet omdat we '
            || 'moeilijk willen doen, maar omdat de mensen die wel komen daar recht op hebben.' || chr(10) || chr(10) ||
            'Wat we van je vragen: laat voor {{attendee.geen_gehoor_deadline}} weten of je erbij bent. '
            || 'Antwoorden op deze mail volstaat, een zin is genoeg.' || chr(10) || chr(10) ||
            'Lukt telefoneren niet omdat je nummer verkeerd bij ons staat of je overdag niet bereikbaar bent? '
            || 'Zeg dat er dan bij, dan handelen we het verder schriftelijk af.' || chr(10) || chr(10) ||
            'Horen we niets voor {{attendee.geen_gehoor_deadline}}, dan gaat je plek naar iemand anders en vervalt '
            || 'je inschrijving.' || chr(10) || chr(10) ||
            'Met vriendelijke groet,' || chr(10) ||
            'Team De Forex Opleiding'
        )
      ),

      -- ── STAP 1 · 48 UUR WACHTEN, MAAR NOOIT TE LAAT ───────────────────
      -- uiterlijk_uren_voor_event = 48: ligt 48 uur na de belstatus ná dat
      -- moment, dan wacht de stap tot 48 uur voor het event. Ligt die grens al
      -- in het verleden, dan is de wachttijd nul en gaat de flow meteen door —
      -- een deadline ná het event is geen deadline.
      jsonb_build_object(
        'type', 'wait',
        'config', jsonb_build_object(
          'amount', 48,
          'unit', 'hours',
          'uiterlijk_uren_voor_event', 48
        )
      ),

      -- ── STAP 2 · IS ER ECHT NIETS BINNENGEKOMEN? ──────────────────────
      -- Waar = geen inkomende WhatsApp en geen inkomende mail sinds
      -- call_status_at. Kan het NIET gemeten worden (geen nummer én geen
      -- mailadres, of een query die faalt), dan is de uitkomst NIET waar en
      -- stopt de flow hier: we nemen nooit een plek af op een meting die niet
      -- kon draaien. Het run-log zegt dan letterlijk niet_gemeten.
      jsonb_build_object(
        'type', 'condition',
        'config', jsonb_build_object(
          'check', 'geen_reactie_sinds_belstatus',
          'on_fail', 'exit'
        )
      ),

      -- ── STAP 3 · DE PLEK VERVALT ──────────────────────────────────────
      -- Status én belstatus in één stap: anders blijft de aanwezigenlijst
      -- staan op 'geen gehoor' bij iemand wiens plek net vervallen is. De
      -- capaciteitscascade (onConfirmedAttendeeMutation) draait hierachter
      -- gewoon door, dus een vol event gaat weer open.
      jsonb_build_object(
        'type', 'update_attendee_status',
        'config', jsonb_build_object(
          'new_status', 'geannuleerd',
          'call_status', 'komt_niet'
        )
      ),

      -- ── STAP 4 · MELDING AAN MAXIM ────────────────────────────────────
      -- De engine hangt er zelf een regel onder met de deelnemer en het event
      -- ([Attendee <mail> · Event <titel>]), dus de namen staan er ook als de
      -- variabelen om welke reden ook leeg blijven.
      jsonb_build_object(
        'type', 'send_internal_notification',
        'config', jsonb_build_object(
          'to_email', 'maxim@deforexopleiding.nl',
          'subject', 'Plek vervallen na geen gehoor: {{attendee.naam}}',
          'body',
            '{{attendee.naam}} ({{attendee.email}} / {{attendee.telefoon}}) is niet te bereiken geweest '
            || 'en heeft ook niet gereageerd op de laatste-kans-mail.' || chr(10) || chr(10) ||
            'Event: {{event.titel}} op {{event.datum}} in {{event.locatie}}.' || chr(10) ||
            'Deadline was: {{attendee.geen_gehoor_deadline}}.' || chr(10) || chr(10) ||
            'Zijn plek is VERVALLEN: inschrijving op geannuleerd, belstatus op komt niet. '
            || 'De plaats is daarmee weer vrij.'
        )
      )
    )
  );

  RAISE NOTICE 'Automatisatie aangemaakt op niveau "%", enabled = false.', v_niveau;
END $$;


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 3 — DE VOORWAARDE IN DE WELKOMSTMAIL
-- ══════════════════════════════════════════════════════════════════════════
--
-- Automatisatie 'Welkom + vragenlijst', stap 0 (send_email).
--
-- 3a · EERST DEZE SELECT. Hij toont de huidige body EN de body zoals hij na de
--      UPDATE wordt, zodat je ziet WAAR de alinea landt. Dit is productietekst
--      die klanten lezen.
--
--      De alinea gaat vóór de afsluitende groet als die te vinden is, en
--      anders onderaan. Leest de voorbeeld-body verkeerd, draai de UPDATE dan
--      NIET en zet de alinea met de hand op de juiste plek via de
--      events-automations UI.

-- SELECT
--   a.id, a.name,
--   a.steps -> 0 -> 'config' ->> 'subject' AS huidig_onderwerp,
--   a.steps -> 0 -> 'config' ->> 'body'    AS huidige_body,
--   position('Let op: je plek is pas definitief' in coalesce(a.steps -> 0 -> 'config' ->> 'body', '')) AS staat_er_al_op_positie,
--   CASE
--     WHEN position('Met vriendelijke groet' in coalesce(a.steps -> 0 -> 'config' ->> 'body', '')) > 0
--       THEN regexp_replace(
--              (a.steps -> 0 -> 'config' ->> 'body'),
--              'Met vriendelijke groet',
--              'Let op: je plek is pas definitief nadat we je telefonisch hebben gesproken. We bellen elke deelnemer persoonlijk - de plaatsen zijn beperkt en gratis, en we houden er geen bezet voor iemand die niet komt.' || chr(10) || chr(10) || 'Met vriendelijke groet'
--            )
--     ELSE (a.steps -> 0 -> 'config' ->> 'body') || chr(10) || chr(10) ||
--          'Let op: je plek is pas definitief nadat we je telefonisch hebben gesproken. We bellen elke deelnemer persoonlijk - de plaatsen zijn beperkt en gratis, en we houden er geen bezet voor iemand die niet komt.'
--   END AS body_na_de_update
-- FROM event_automations a
-- WHERE a.name = 'Welkom + vragenlijst';

-- 3b · DE UPDATE. Idempotent via de WHERE op position(...) = 0: staat de
--      alinea er al, dan raakt dit statement de rij niet aan.
--
--      Rollback:
--        UPDATE event_automations SET steps = jsonb_set(steps, '{0,config,body}',
--          to_jsonb(replace(replace(steps -> 0 -> 'config' ->> 'body',
--            'Let op: je plek is pas definitief nadat we je telefonisch hebben gesproken. We bellen elke deelnemer persoonlijk - de plaatsen zijn beperkt en gratis, en we houden er geen bezet voor iemand die niet komt.' || chr(10) || chr(10), ''),
--            chr(10) || chr(10) || 'Let op: je plek is pas definitief nadat we je telefonisch hebben gesproken. We bellen elke deelnemer persoonlijk - de plaatsen zijn beperkt en gratis, en we houden er geen bezet voor iemand die niet komt.', '')))
--        WHERE name = 'Welkom + vragenlijst';

UPDATE public.event_automations a
   SET steps = jsonb_set(
         a.steps,
         '{0,config,body}',
         to_jsonb(
           CASE
             WHEN position('Met vriendelijke groet' in (a.steps -> 0 -> 'config' ->> 'body')) > 0
               -- regexp_replace ZONDER 'g'-vlag raakt alleen de EERSTE
               -- treffer. Staat de groet er twee keer (bv. in een citaat), dan
               -- komt de alinea toch maar één keer in de mail. Het patroon
               -- heeft geen metatekens en de alinea geen '&' of backslash, dus
               -- er valt niets te escapen.
               THEN regexp_replace(
                      (a.steps -> 0 -> 'config' ->> 'body'),
                      'Met vriendelijke groet',
                      'Let op: je plek is pas definitief nadat we je telefonisch hebben gesproken. We bellen elke deelnemer persoonlijk - de plaatsen zijn beperkt en gratis, en we houden er geen bezet voor iemand die niet komt.' || chr(10) || chr(10) || 'Met vriendelijke groet'
                    )
             ELSE (a.steps -> 0 -> 'config' ->> 'body') || chr(10) || chr(10) ||
                  'Let op: je plek is pas definitief nadat we je telefonisch hebben gesproken. We bellen elke deelnemer persoonlijk - de plaatsen zijn beperkt en gratis, en we houden er geen bezet voor iemand die niet komt.'
           END
         )
       ),
       updated_at = now()
 WHERE a.name = 'Welkom + vragenlijst'
   AND a.steps -> 0 ->> 'type' = 'send_email'
   AND a.steps -> 0 -> 'config' ->> 'body' IS NOT NULL
   AND position('Let op: je plek is pas definitief' in (a.steps -> 0 -> 'config' ->> 'body')) = 0;


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 4 — DEZELFDE ALINEA IN DE BEVESTIGINGSMAIL
-- ══════════════════════════════════════════════════════════════════════════
--
-- Automatisatie 'Bevestiging aanmelding', stap 0 (send_email).
--
-- 4a · EERST DEZE SELECT. Zelfde vorm als 3a.

-- SELECT
--   a.id, a.name,
--   a.steps -> 0 -> 'config' ->> 'subject' AS huidig_onderwerp,
--   a.steps -> 0 -> 'config' ->> 'body'    AS huidige_body,
--   position('Let op: je plek is pas definitief' in coalesce(a.steps -> 0 -> 'config' ->> 'body', '')) AS staat_er_al_op_positie,
--   CASE
--     WHEN position('Met vriendelijke groet' in coalesce(a.steps -> 0 -> 'config' ->> 'body', '')) > 0
--       THEN regexp_replace(
--              (a.steps -> 0 -> 'config' ->> 'body'),
--              'Met vriendelijke groet',
--              'Let op: je plek is pas definitief nadat we je telefonisch hebben gesproken. We bellen elke deelnemer persoonlijk - de plaatsen zijn beperkt en gratis, en we houden er geen bezet voor iemand die niet komt.' || chr(10) || chr(10) || 'Met vriendelijke groet'
--            )
--     ELSE (a.steps -> 0 -> 'config' ->> 'body') || chr(10) || chr(10) ||
--          'Let op: je plek is pas definitief nadat we je telefonisch hebben gesproken. We bellen elke deelnemer persoonlijk - de plaatsen zijn beperkt en gratis, en we houden er geen bezet voor iemand die niet komt.'
--   END AS body_na_de_update
-- FROM event_automations a
-- WHERE a.name = 'Bevestiging aanmelding';

-- 4b · DE UPDATE. Rollback: zie 3b, met deze naam.

UPDATE public.event_automations a
   SET steps = jsonb_set(
         a.steps,
         '{0,config,body}',
         to_jsonb(
           CASE
             WHEN position('Met vriendelijke groet' in (a.steps -> 0 -> 'config' ->> 'body')) > 0
               -- regexp_replace ZONDER 'g'-vlag raakt alleen de EERSTE
               -- treffer. Staat de groet er twee keer (bv. in een citaat), dan
               -- komt de alinea toch maar één keer in de mail. Het patroon
               -- heeft geen metatekens en de alinea geen '&' of backslash, dus
               -- er valt niets te escapen.
               THEN regexp_replace(
                      (a.steps -> 0 -> 'config' ->> 'body'),
                      'Met vriendelijke groet',
                      'Let op: je plek is pas definitief nadat we je telefonisch hebben gesproken. We bellen elke deelnemer persoonlijk - de plaatsen zijn beperkt en gratis, en we houden er geen bezet voor iemand die niet komt.' || chr(10) || chr(10) || 'Met vriendelijke groet'
                    )
             ELSE (a.steps -> 0 -> 'config' ->> 'body') || chr(10) || chr(10) ||
                  'Let op: je plek is pas definitief nadat we je telefonisch hebben gesproken. We bellen elke deelnemer persoonlijk - de plaatsen zijn beperkt en gratis, en we houden er geen bezet voor iemand die niet komt.'
           END
         )
       ),
       updated_at = now()
 WHERE a.name = 'Bevestiging aanmelding'
   AND a.steps -> 0 ->> 'type' = 'send_email'
   AND a.steps -> 0 -> 'config' ->> 'body' IS NOT NULL
   AND position('Let op: je plek is pas definitief' in (a.steps -> 0 -> 'config' ->> 'body')) = 0;


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 5 — VERIFICATIE
-- ══════════════════════════════════════════════════════════════════════════

-- 5a · De nieuwe automatisatie: staat hij er, staat hij UIT, en kloppen de
--      vijf stappen?
-- SELECT a.name, a.enabled, a.enabled_at, a.trigger_type, a.trigger_config,
--        a.scope_type, a.scope_config, a.enroll_mode,
--        jsonb_array_length(a.steps) AS n_steps,
--        (SELECT jsonb_agg(jsonb_build_object('idx', o - 1, 'type', s ->> 'type'
--                 , 'config', s -> 'config') ORDER BY o)
--           FROM jsonb_array_elements(a.steps) WITH ORDINALITY AS t(s, o)) AS stappen
--   FROM event_automations a
--  WHERE a.name = 'Geen gehoor - laatste kans';

-- 5b · Staat de alinea nu in beide mails, en precies één keer?
-- SELECT name,
--        position('Let op: je plek is pas definitief' in (steps -> 0 -> 'config' ->> 'body')) AS op_positie,
--        (length(steps -> 0 -> 'config' ->> 'body')
--         - length(replace(steps -> 0 -> 'config' ->> 'body', 'Let op: je plek is pas definitief', '')))
--        / length('Let op: je plek is pas definitief') AS aantal_keer,
--        steps -> 0 -> 'config' ->> 'body' AS body
--   FROM event_automations
--  WHERE name IN ('Welkom + vragenlijst', 'Bevestiging aanmelding');

-- 5c · Niemand mag nu al ingeschreven staan (de automatisatie staat uit).
-- SELECT count(*) AS runs
--   FROM event_automation_runs r
--   JOIN event_automations a ON a.id = r.automation_id
--  WHERE a.name = 'Geen gehoor - laatste kans';


-- ══════════════════════════════════════════════════════════════════════════
-- DE WHATSAPP-STAP — LATER, ALS META DE TEMPLATE GOEDKEURT
-- ══════════════════════════════════════════════════════════════════════════
--
-- De stap hoort TUSSEN stap 0 (de mail) en stap 1 (het wachten): eerst beide
-- kanalen, dan de klok. Hij past er los tussen omdat elke stap zijn eigen
-- index heeft en de engine ze op volgorde afloopt.
--
-- Zodra de template op APPROVED staat in whatsapp_meta_templates:
--
--   UPDATE public.event_automations
--      SET steps = jsonb_insert(steps, '{1}', jsonb_build_object(
--            'type', 'send_whatsapp',
--            'config', jsonb_build_object('template_name', '<de goedgekeurde naam>')
--          )),
--          updated_at = now()
--    WHERE name = 'Geen gehoor - laatste kans'
--      AND NOT (steps::text LIKE '%send_whatsapp%');
--
-- Twee dingen om te weten:
--  · De template heeft named placeholders nodig met een non-null
--    meta_param_mapping, en de link hoort in de BODY, niet in een button —
--    zie docs/whatsapp-templates-c4-named-variables.md.
--  · Lopende runs houden hun eigen steps_snapshot en krijgen deze stap NIET.
--    Alleen wie daarna ingeschreven wordt, krijgt mail én WhatsApp.
