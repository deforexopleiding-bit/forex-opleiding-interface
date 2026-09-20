-- 2026-09-17 — ANNULATIE-AUTOMATISATIE: nulpunt, trigger en de automatisatie
--
-- ══════════════════════════════════════════════════════════════════════════
--  WAT DIT BESTAND DOET, IN DRIE STAPPEN
-- ══════════════════════════════════════════════════════════════════════════
--  STAP 1  Twee kolommen op event_attendees: cancelled_at (timestamptz) en
--          cancelled_reason (text). Additief, nullable, GEEN backfill.
--
--  STAP 2  CHECK op event_automations.trigger_type uitbreiden met 'on_status'.
--          BLOKKEREND: zonder deze stap weigert Postgres elke automatisatie
--          met de nieuwe trigger (23514), ook al laat de app-validatie in
--          api/events-automation-save.js hem door.
--
--  STAP 3  Nieuwe automatisatie 'Annulatie bevestigd', enabled = FALSE.
--          Twee stappen: mail + WhatsApp.
--
--  STAP 4  Verificatie.
--
-- ══════════════════════════════════════════════════════════════════════════
--  ⚠ BLOKKEREND — DRAAI DIT VÓÓR OF DIRECT NA DE MERGE
-- ══════════════════════════════════════════════════════════════════════════
--  De code noemt cancelled_at en cancelled_reason BIJ NAAM in UPDATE-patches
--  (api/events-attendee-status-change.js, zetKomtNiet() in
--  api/opvolging-aanmelding-actie.js, en de update_attendee_status-stap in
--  api/_lib/events-automation-engine.js). Een UPDATE die een niet-bestaande
--  kolom noemt faalt VOLLEDIG met `column "cancelled_at" does not exist` —
--  "nullable dus optioneel" geldt voor bestaande rijen, niet voor nieuwe
--  writes die de kolom noemen.
--
--  WAT ER STUKGAAT ZONDER DEZE MIGRATIE:
--    · iemand annuleren in de eventmodule → 500, de annulatie gaat niet door;
--    · 'komt niet' / 'liever via zoom' in Opvolging → idem;
--    · stap 4 van 'Geen gehoor - laatste kans' → de plek vervalt niet meer.
--  Dat is dus geen cosmetisch gebrek maar drie kapotte knoppen.
--
--  Ook de SELECT in loadCandidatesForAutomation noemt beide kolommen, dus
--  zonder migratie stopt de hele enrollment (alle triggers).
--
-- ══════════════════════════════════════════════════════════════════════════
--  GEEN BACKFILL, EN DAT IS DE HELE BEDOELING
-- ══════════════════════════════════════════════════════════════════════════
--  Op het moment van bouwen staan er 35 rijen op 'geannuleerd'. Die krijgen
--  GEEN cancelled_at. Dat is geen vergetelheid maar de veiligheidsmaatregel:
--
--    enroll_mode 'new_only' eist `cancelled_at IS NOT NULL AND >= enabled_at`.
--    Geen stempel = niet nieuw = nooit kandidaat.
--
--  Zou je die 35 rijen wél stempelen (met welke datum dan ook), dan bepaalt
--  het toeval of ze boven of onder enabled_at vallen en kan het aanzetten van
--  de automatisatie in één klap 35 mensen mailen over een annulatie van weken
--  terug. Dezelfde val die we bij 'Geen gehoor - laatste kans' ontweken
--  hebben met call_status_at.
--
--  Wil je er later toch iemand van hebben: annuleer die rij opnieuw via de
--  UI. Dan komt er een verse cancelled_at en stroomt hij normaal in.
--
-- ══════════════════════════════════════════════════════════════════════════
--  TERUGDRAAIEN
-- ══════════════════════════════════════════════════════════════════════════
--    STAP 3 → DELETE FROM event_automations WHERE name = 'Annulatie bevestigd';
--    STAP 2 → de CHECK opnieuw zetten zonder 'on_status' (kan alleen als er
--             geen rij met die trigger meer staat).
--    STAP 1 → ALTER TABLE public.event_attendees
--               DROP COLUMN cancelled_reason, DROP COLUMN cancelled_at;
--             Dit gooit de nulpunten weg; daarna zou een nieuwe automatisatie
--             weer vanaf nul moeten opbouwen.
--
-- ══════════════════════════════════════════════════════════════════════════
--  NOG DOOR MAXIM TE DOEN NA DEZE MIGRATIE
-- ══════════════════════════════════════════════════════════════════════════
--   1. NIETS MEER AAN DE TEMPLATE. Die is op 20 september goedgekeurd
--      ('annulatie_bevestigd', nl, meta_template_id 1663591608705534) en zit
--      met mapping in stap 1 hieronder. De mapping staat in de STAP, niet in
--      de DB-rij (die heeft meta_param_mapping NULL, zoals 26 andere
--      goedgekeurde templates) — zonder die mapping weigert Meta met 132000.
--   2. De automatisatie testen met de automatisatie-tester (Automatiseringen >
--      Events > Test). Die zet de testdeelnemer nu zelf op 'geannuleerd' met
--      een verse cancelled_at, dus de flow is end-to-end te zien zonder dat
--      er een echte deelnemer aan te pas komt.
--   3. Pas dan aanzetten. enabled blijft FALSE tot jij hem omzet.


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 1 — DE KOLOMMEN
-- ══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.event_attendees
  ADD COLUMN IF NOT EXISTS cancelled_at     timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_reason text;

COMMENT ON COLUMN public.event_attendees.cancelled_at IS
  'Moment waarop status op ''geannuleerd'' ging. Nulpunt voor enroll_mode ''new_only'' van '
  'de on_status-trigger. BEWUST NIET GEBACKFILD: geen stempel betekent niet-nieuw, zodat '
  'bestaande annulaties nooit met terugwerkende kracht een annulatiemail krijgen.';

COMMENT ON COLUMN public.event_attendees.cancelled_reason IS
  'Wie annuleerde: manual (CRM) | opvolging_komt_niet | liever_zoom | automation. '
  'De annulatie-automatisatie slaat ''automation'' en ''liever_zoom'' over — de eerste heeft '
  'zijn eigen bericht al gestuurd (Geen gehoor - laatste kans stap 0/1), de tweede haakt niet '
  'af maar wil online meedoen. Zie GEEN_ANNULATIEMAIL_REDENEN in '
  'api/_lib/events-automation-engine.js.';

-- Index op het nulpunt: de kandidaat-query filtert er op bij elke cron-tick.
-- Partieel, want alleen de gestempelde rijen doen mee.
CREATE INDEX IF NOT EXISTS idx_event_attendees_cancelled_at
  ON public.event_attendees (cancelled_at)
  WHERE cancelled_at IS NOT NULL;


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 2 — DE TRIGGER TOELATEN
-- ══════════════════════════════════════════════════════════════════════════
-- Zonder deze stap faalt stap 3 met 23514, en faalt ook elke poging om de
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
    'on_call_status',
    'on_status'
  ));

COMMENT ON COLUMN public.event_automations.trigger_type IS
  'on_signup | on_assessment_completed | time_before_event | on_assessment_not_completed_after | on_call_status | on_status. '
  'on_status leest trigger_config.status en start zodra event_attendees.status daarop staat; '
  'enroll_mode new_only toetst dan op cancelled_at (niet op registered_at), en werkt daarom '
  'vandaag alleen voor status ''geannuleerd'' — de enige status met een eigen tijdstempel.';


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 3 — DE AUTOMATISATIE. enabled = FALSE.
-- ══════════════════════════════════════════════════════════════════════════
--
-- Eén DO-block, want de niveau-slug moet eerst opgezocht worden en er mag
-- NIETS geschreven worden als die niet bestaat. Zelfde vorm als de
-- geen-gehoor-migratie van 14 september.
--
-- Idempotent: bestaat de rij al (op naam), dan doet dit block niets.

DO $$
DECLARE
  v_niveau  text;
  v_slugs   text;
  v_bestaat uuid;
BEGIN
  SELECT id INTO v_bestaat FROM public.event_automations
   WHERE name = 'Annulatie bevestigd' LIMIT 1;
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
    'Annulatie bevestigd',
    'Start zodra de inschrijvingsstatus op geannuleerd gaat. Mail + WhatsApp dat de plek is '
    || 'vrijgegeven. Slaat annulaties over die een automatisatie zelf deed (cancelled_reason '
    || '''automation'' — Geen gehoor - laatste kans heeft dan al gemaild) en die van '
    || '''liever_zoom'' (die haakt niet af). De WhatsApp-stap wacht op de Meta-template.',
    false,      -- UIT. Aanzetten gebeurt in de eventmodule, niet hier.
    null,       -- enabled_at wordt gezet bij het aanzetten; dat is ook de
                -- grens waarop enroll_mode 'new_only' toetst.
    'on_status',
    jsonb_build_object('status', 'geannuleerd'),
    'niveau',
    jsonb_build_object('niveau', v_niveau),
    'new_only', -- ZONDER DIT MAILT AANZETTEN ALLE 35 BESTAANDE ANNULATIES.
    jsonb_build_array(

      -- ── STAP 0 · DE MAIL ──────────────────────────────────────────────
      -- {{event.datum}} en {{event.locatie}} en geen vaste stad: deze
      -- automatisatie hangt aan een NIVEAU, dus hij pakt elke masterclass.
      -- Een vaste stad zou 'in Gent' schrijven in een mail over Antwerpen.
      jsonb_build_object(
        'type', 'send_email',
        'config', jsonb_build_object(
          'subject', 'Je inschrijving voor de masterclass is geannuleerd',
          'body',
             'Beste {{attendee.voornaam}},' || chr(10) || chr(10)
          || 'je inschrijving voor de Forex Masterclass van {{event.datum}} in {{event.locatie}} '
          || 'is geannuleerd. Je plek is vrijgegeven.' || chr(10) || chr(10)
          || 'We werken met kleine groepen en de plaatsen zijn beperkt, dus we houden er geen '
          || 'bezet — dat is geen verwijt, het is precies waarom de mensen die er wél zitten de '
          || 'aandacht krijgen die ze verdienen.' || chr(10) || chr(10)
          || 'Verandert er iets, dan ben je welkom op een volgende datum. Schrijf je opnieuw in '
          || 'en we bellen je persoonlijk op om je plek te bevestigen.' || chr(10) || chr(10)
          || 'Met vriendelijke groet,' || chr(10)
          || 'De Forex Opleiding'
        )
      ),

      -- ── STAP 1 · DE WHATSAPP ──────────────────────────────────────────
      -- De template is APPROVED (20 september): naam 'annulatie_bevestigd',
      -- taal nl, meta_template_id 1663591608705534, map 'Event Automations'.
      --
      -- ── DE MAPPING GAAT HIER EXPLICIET MEE, EN DAT IS GEEN LUXE ───────
      -- whatsapp_meta_templates.meta_param_mapping is voor deze rij NULL, en
      -- dat is niet uitzonderlijk: 26 van de goedgekeurde templates hebben dat
      -- veld leeg. Een template met een {{N}}-body en 0 meegestuurde
      -- parameters weigert Meta met 132000 — dus zonder deze mapping komt er
      -- géén WhatsApp aan, ook al is de template goedgekeurd.
      --
      -- De body is: 'Hallo {{1}}, je inschrijving voor de Forex Masterclass
      -- van {{2}} is geannuleerd en je plek is vrijgegeven...'
      --   {{1}} = attendee.voornaam
      --   {{2}} = event.datum
      --
      -- Zelfde aanpak als PARAM_MAPPING in api/_lib/events-invite.js. De
      -- engine geeft dit door als paramMappingOverride, en dat is een
      -- FALLBACK: staat er later wél een mapping in de DB, dan wint die. Zet
      -- hem dus bij voorkeur ook in het templatescherm, zodat het scherm 'm
      -- toont — maar de send hangt er niet meer van af.
      --
      -- DIT FAALT NIET STIL. Gaat er hier toch iets mis (template verwijderd,
      -- status niet meer APPROVED, Meta weigert), dan komt de reden sinds
      -- #1625 op de run (last_error) én als 'WHATSAPP_ONBEREIKBAAR'-markering
      -- op de deelnemer, dus in de lijst en niet drie klikken diep. En omdat
      -- de mail stap 0 is en dit stap 1, gaat de mail hoe dan ook gewoon uit.
      jsonb_build_object(
        'type', 'send_whatsapp',
        'config', jsonb_build_object(
          'template_name', 'annulatie_bevestigd',
          'template_lang', 'nl',
          'naam_voor_mensen', 'Annulatie bevestigd (WhatsApp)',
          'param_mapping', jsonb_build_object(
            'body', jsonb_build_object(
              '1', 'attendee.voornaam',
              '2', 'event.datum'
            )
          )
        )
      )

    )
  );

  RAISE NOTICE 'Automatisatie ''Annulatie bevestigd'' aangemaakt op niveau %, enabled = FALSE.', v_niveau;
END $$;


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 4 — VERIFICATIE
-- ══════════════════════════════════════════════════════════════════════════

-- 4a · Staan de kolommen er, en is er ECHT niet gebackfild?
--      cancelled_at hoort 0 te zijn bij de bestaande annulaties.
SELECT
  count(*)                                        AS geannuleerd_totaal,
  count(cancelled_at)                             AS met_stempel,
  count(*) - count(cancelled_at)                  AS zonder_stempel_dus_veilig
FROM public.event_attendees
WHERE status = 'geannuleerd' AND is_test = false;

-- 4b · Staat de automatisatie er, en staat hij UIT?
SELECT name, enabled, trigger_type, trigger_config, scope_type, scope_config,
       enroll_mode, jsonb_array_length(steps) AS aantal_stappen
  FROM public.event_automations
 WHERE name = 'Annulatie bevestigd';

-- 4c · Laat de CHECK de nieuwe trigger toe?
SELECT pg_get_constraintdef(oid) AS trigger_type_check
  FROM pg_constraint
 WHERE conname = 'event_automations_trigger_type_check';


-- ══════════════════════════════════════════════════════════════════════════
--  DE WHATSAPP-TEKST (AL GOEDGEKEURD — hier voor de naslag)
-- ══════════════════════════════════════════════════════════════════════════
--  Named placeholders, zoals de rest van de templates sinds C4. De mapping
--  wordt bij submit automatisch naar positioneel omgezet; zie
--  docs/whatsapp-templates-c4-named-variables.md.
--
--  BODY:
--    Hallo {{attendee.voornaam}}, je inschrijving voor de Forex Masterclass
--    van {{event.datum}} is geannuleerd en je plek is vrijgegeven. Wil je er
--    later toch bij zijn, laat het ons weten — dan bekijken we samen een
--    volgende datum. De Forex Opleiding
--
--  Let op: de link-in-body-regel uit de sessie van 17-18 juni geldt hier niet
--  (er zit geen link in), en beide variabelen bestaan al in de registry
--  (AVAILABLE_VARIABLES in api/_lib/template-variables.js).
