-- ============================================================================
-- Opvolging — twee waarden erbij op de CHECK-constraints van opvolging_taken
-- Datum: 2026-09-05
-- Branch: feat/opvolging-aanmeldingen
--
-- VASTLEGGING. Deze twee zijn op 5 september met de hand op productie gezet,
-- vóór de code die ze gebruikt. Dit bestand is de herhaalbare versie, zodat een
-- verse omgeving niet tegen een insert loopt die de constraint weigert.
--
-- ── WAAROM 'aanmelding' ─────────────────────────────────────────────────────
-- De vijf bestaande redenen beschrijven allemaal een situatie NA contact:
--   wil_nog_beslissen · no_show_event · no_show_call · afgemeld · niet_ingepland
-- Vanaf nu komt iemand al in de takenlijst zodra hij zich voor een event
-- aanmeldt — dus vóór er iets gebeurd is, en vóór het event zelf. Daar paste
-- geen van de vijf op. Een bestaande reden oprekken zou de betekenis van de
-- cijfers erachter stilletjes veranderen: 'niet_ingepland' telt in het
-- dashboard als iemand die iets had moeten inplannen en dat niet deed, en een
-- verse aanmelding is dat niet.
--
-- ── WAAROM 'wacht_verplaatsing' APART VAN 'wacht_inplanning' ────────────────
-- Allebei zijn het "de kaart is even uit de lijst en komt terug als er na 48
-- uur niets gebeurd is", en het is verleidelijk om er één status van te maken.
-- Dat gaat mis in cron-opvolging-wacht-check, want de twee zoeken naar ANDER
-- bewijs:
--   wacht_inplanning   → is er een AFSPRAAK geboekt in follow_up_appointments?
--   wacht_verplaatsing → staat deze persoon als 'aangemeld' op een ANDER event
--                        in event_attendees?
-- Met één status zou de controle bij elke kaart beide kanten moeten aflopen en
-- zou een gevonden afspraak een openstaande verplaatsing kunnen afsluiten (of
-- omgekeerd). Dan sluit een kaart om de verkeerde reden, en dat is precies het
-- soort fout dat niemand terugziet: de kaart is weg, dus er is niets meer om
-- naar te kijken.
--
-- ── IDEMPOTENT ─────────────────────────────────────────────────────────────
-- Een CHECK-constraint is niet uit te breiden; hij moet vervangen worden. Dat
-- gebeurt hier met DROP IF EXISTS gevolgd door ADD met de volledige lijst, dus
-- opnieuw draaien levert exact dezelfde constraint op. Draait dit op een
-- databank waar de waarden er al in zitten (zoals productie), dan verandert er
-- niets.
--
-- De ADD valideert bestaande rijen. Staat er een rij met een waarde die niet in
-- de lijst voorkomt, dan faalt het statement — en dat is goed: dan klopt de
-- lijst niet en moet je dat weten, niet stilzwijgend overslaan met NOT VALID.
--
-- Beide statements staan los van elkaar, dus het knippen op statement-grenzen
-- door de Supabase SQL-editor is hier onschadelijk.
-- ============================================================================

-- ── reden: 'aanmelding' erbij ───────────────────────────────────────────────
ALTER TABLE public.opvolging_taken
  DROP CONSTRAINT IF EXISTS opvolging_taken_reden_chk;

ALTER TABLE public.opvolging_taken
  ADD CONSTRAINT opvolging_taken_reden_chk CHECK (reden IN (
    'wil_nog_beslissen',
    'no_show_event',
    'no_show_call',
    'afgemeld',
    'niet_ingepland',
    'aanmelding'          -- 2026-09-05: instroom bij aanmelding voor een event
  ));

-- ── status: 'wacht_verplaatsing' erbij ──────────────────────────────────────
ALTER TABLE public.opvolging_taken
  DROP CONSTRAINT IF EXISTS opvolging_taken_status_chk;

ALTER TABLE public.opvolging_taken
  ADD CONSTRAINT opvolging_taken_status_chk CHECK (status IN (
    'open',
    'wacht_inplanning',
    'ingepland',
    'gearchiveerd',
    'wacht_verplaatsing'  -- 2026-09-05: Dave gaf 'verplaatst' aan, wachten op bewijs
  ));

-- ── CONTROLE (los te draaien) ───────────────────────────────────────────────
-- Verwacht: beide constraints bestaan en noemen de nieuwe waarde.
--
-- SELECT conname, pg_get_constraintdef(oid)
-- FROM pg_constraint
-- WHERE conrelid = 'public.opvolging_taken'::regclass
--   AND conname IN ('opvolging_taken_reden_chk','opvolging_taken_status_chk');

-- ── ROLLBACK (indien nodig) ─────────────────────────────────────────────────
-- Werkt alleen zolang er nog geen rijen met de nieuwe waarden bestaan; anders
-- weigert de ADD terecht. Ruim die rijen dan eerst op.
--
-- ALTER TABLE public.opvolging_taken DROP CONSTRAINT IF EXISTS opvolging_taken_reden_chk;
-- ALTER TABLE public.opvolging_taken ADD CONSTRAINT opvolging_taken_reden_chk CHECK (reden IN
--   ('wil_nog_beslissen','no_show_event','no_show_call','afgemeld','niet_ingepland'));
-- ALTER TABLE public.opvolging_taken DROP CONSTRAINT IF EXISTS opvolging_taken_status_chk;
-- ALTER TABLE public.opvolging_taken ADD CONSTRAINT opvolging_taken_status_chk CHECK (status IN
--   ('open','wacht_inplanning','ingepland','gearchiveerd'));
