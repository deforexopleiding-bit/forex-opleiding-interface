-- 2026-08-18-events-auto-close-trigger.sql
--
-- Doel: harde DB-side guarantee dat een event NOOIT open kan blijven staan
-- terwijl het bevestigde-aantal >= capacity is. Sluit het gat dat ontstaat
-- wanneer een nieuw endpoint schrijft naar event_attendees zonder de Node
-- helper autoCloseIfFull aan te roepen.
--
-- Wat deze migratie doet:
--   1. IMMUTABLE SQL function event_attendee_is_confirmed(status, arId, is_test)
--      -> single source of truth voor de "telt-mee"-definitie. Node
--      getConfirmedCount + trigger + reconcile-cron gebruiken exact dezelfde
--      predicate; split-brain onmogelijk.
--   2. STABLE SQL function event_confirmed_count(event_id) voor
--      Node-consumers via RPC (spiegel van getConfirmedCount).
--   3. Trigger fn_event_attendees_auto_close: AFTER INSERT/UPDATE OF
--      (status, assessment_response_id, is_test) op event_attendees. Firet
--      alleen bij een echte RISE van non-confirmed -> confirmed. Zet
--      events.signups_closed=true (met race-safe guarded UPDATE) zodra
--      confirmed_count >= capacity.
--   4. Eenmalige backfill van events die NU exact-vol-maar-open staan
--      (op basis van de dry-run 2026-08-18 verwacht 0 rijen; de LOOP is
--      idempotent en veilig te herhalen).
--
-- Guardrails (bewust ingebouwd):
--   1. Predicate identiek aan getConfirmedCount: status IN
--      ('aangemeld','aanwezig') AND assessment_response_id IS NOT NULL AND
--      is_test = false. NULL-is_test-rijen tellen NIET (spiegel van
--      .eq('is_test', false)).
--   2. Capacity NULL of <= 0 = ongelimiteerd -> trigger slaat over (geen
--      NULL -> 0-fallback).
--   3. Race-safe: guarded UPDATE ... WHERE signups_closed=false RETURNING id.
--      Twee gelijktijdige inserts serialize via row-lock op events; de 2e
--      krijgt 0 rijen terug en doet niets (idempotent).
--   4. is_test = false hard-gate zowel in de predicate als in de trigger-
--      trigger-conditie (RISE-check). Test-events kunnen dus nooit sluiten.
--   5. Trigger doet ALLEEN de DB-flip. Webflow/GHL outbound blijft in Node
--      (autoCloseIfFull via de shared helper onConfirmedAttendeeMutation).
--      De reconcile-cron (10 min) vangt drift op als een Node-caller de
--      helper mist EN de trigger de DB al gesloten heeft.
--
-- Toepassen: run dit script in Supabase SQL-editor (productie). Idempotent
-- via CREATE OR REPLACE + DROP TRIGGER IF EXISTS + guarded backfill.

-- ═══ 1. Confirmed predicate ══════════════════════════════════════════════
CREATE OR REPLACE FUNCTION event_attendee_is_confirmed(
  p_status                 text,
  p_assessment_response_id uuid,
  p_is_test                boolean
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT p_status = ANY (ARRAY['aangemeld','aanwezig'])
     AND p_assessment_response_id IS NOT NULL
     AND p_is_test = false;
$$;

COMMENT ON FUNCTION event_attendee_is_confirmed(text, uuid, boolean) IS
  'Single source of truth voor "telt-mee voor capaciteit". Spiegel van '
  'Node getConfirmedCount. Aanpassing hier vereist gelijktijdige update van '
  'CONFIRMED_STATUSES + is_test-filter in api/_lib/event-registration.js.';

-- ═══ 2. Confirmed-count RPC ═════════════════════════════════════════════
CREATE OR REPLACE FUNCTION event_confirmed_count(p_event_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  -- status::text want event_attendees.status is een enum (event_attendee_status);
  -- Postgres cast enum niet impliciet naar text voor function-arg matching.
  SELECT COUNT(*)::int
  FROM event_attendees
  WHERE event_id = p_event_id
    AND event_attendee_is_confirmed(status::text, assessment_response_id, is_test);
$$;

COMMENT ON FUNCTION event_confirmed_count(uuid) IS
  'RPC-variant van getConfirmedCount. Gebruikt event_attendee_is_confirmed. '
  'Kan aangeroepen worden via supabase.rpc(). Voorkeur boven inline query '
  'zodat de predicate op één plek leeft.';

-- ═══ 3. Auto-close trigger ══════════════════════════════════════════════
CREATE OR REPLACE FUNCTION fn_event_attendees_auto_close()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_event_id              uuid;
  v_cap                   integer;
  v_count                 integer;
  v_rise_to_confirmed     boolean := false;
BEGIN
  -- Bepaal of deze mutatie een rise-naar-confirmed veroorzaakt.
  IF TG_OP = 'INSERT' THEN
    v_event_id := NEW.event_id;
    v_rise_to_confirmed := event_attendee_is_confirmed(
      NEW.status::text, NEW.assessment_response_id, NEW.is_test
    );
  ELSIF TG_OP = 'UPDATE' THEN
    v_event_id := NEW.event_id;
    -- RISE: was NIET-confirmed vóór, IS confirmed nu.
    -- status::text want event_attendees.status is een enum (event_attendee_status).
    v_rise_to_confirmed :=
          event_attendee_is_confirmed(NEW.status::text, NEW.assessment_response_id, NEW.is_test)
      AND NOT event_attendee_is_confirmed(OLD.status::text, OLD.assessment_response_id, OLD.is_test);
  END IF;

  -- Skip: geen rise -> geen capaciteits-check nodig. Verlaagt trigger-load
  -- op non-confirmed updates (bv. naam/email edits).
  IF NOT v_rise_to_confirmed OR v_event_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Guardrail 2: capacity NULL of <= 0 = ongelimiteerd -> nooit sluiten.
  SELECT capacity INTO v_cap FROM events WHERE id = v_event_id;
  IF v_cap IS NULL OR v_cap <= 0 THEN
    RETURN NEW;
  END IF;

  -- Recount confirmed via dezelfde predicate.
  v_count := event_confirmed_count(v_event_id);

  IF v_count < v_cap THEN
    RETURN NEW;
  END IF;

  -- Guardrail 3: race-safe conditional UPDATE. Als iemand anders 'm net
  -- gesloten heeft (bv. concurrent insert), krijgt de 2e trigger-call 0
  -- rijen terug en doet niets. signups_closed_by_user_id blijft NULL want
  -- dit is een system-close.
  UPDATE events
     SET signups_closed            = true,
         signups_closed_at         = now(),
         signups_closed_reason     = 'auto_full',
         signups_closed_by_user_id = NULL
   WHERE id                = v_event_id
     AND signups_closed    = false
     AND capacity          IS NOT NULL
     AND capacity          > 0;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION fn_event_attendees_auto_close() IS
  'Trigger-function op event_attendees (AFTER INSERT/UPDATE). Sluit event '
  'signups_closed=true zodra confirmed_count >= capacity. Doet ALLEEN de '
  'DB-flip; Webflow/GHL outbound blijft in Node via de shared helper '
  'onConfirmedAttendeeMutation + de reconcile-cron als drift-vangnet.';

-- Drop-and-recreate voor idempotency (CREATE TRIGGER heeft geen IF NOT EXISTS
-- in oudere Postgres-versies, dus veiligste patroon).
DROP TRIGGER IF EXISTS trg_event_attendees_auto_close ON event_attendees;

CREATE TRIGGER trg_event_attendees_auto_close
  AFTER INSERT OR UPDATE OF status, assessment_response_id, is_test
  ON event_attendees
  FOR EACH ROW
  EXECUTE FUNCTION fn_event_attendees_auto_close();

-- ═══ 4. Eenmalige backfill ══════════════════════════════════════════════
-- Sluit alle events die NU exact-vol-maar-open staan (dry-run 2026-08-18:
-- 0 rijen verwacht, maar de LOOP is idempotent en veilig te herhalen).
-- Doet alleen de DB-flip; Webflow/GHL outbound-sync gebeurt via de
-- reconcile-cron of via een expliciete admin-actie na deze migratie.
DO $$
DECLARE
  r         record;
  n_closed  integer := 0;
BEGIN
  FOR r IN
    SELECT e.id, e.capacity, event_confirmed_count(e.id) AS cnt
    FROM events e
    WHERE e.status <> 'archived'
      AND e.signups_closed = false
      AND e.capacity IS NOT NULL
      AND e.capacity > 0
      AND event_confirmed_count(e.id) >= e.capacity
  LOOP
    UPDATE events
       SET signups_closed            = true,
           signups_closed_at         = now(),
           signups_closed_reason     = 'auto_full',
           signups_closed_by_user_id = NULL
     WHERE id             = r.id
       AND signups_closed = false;
    IF FOUND THEN
      n_closed := n_closed + 1;
      RAISE NOTICE 'Backfill sloot event % (cap=%, cnt=%)', r.id, r.capacity, r.cnt;
    END IF;
  END LOOP;
  RAISE NOTICE 'Backfill klaar: % events gesloten.', n_closed;
END $$;

-- ═══ Verificatie-queries (mag je apart draaien na de migratie) ══════════
-- Alle events die na de migratie nog exact-vol-maar-open zijn (moet 0 zijn):
--   SELECT e.id, e.title, e.event_date, e.capacity, event_confirmed_count(e.id) AS cnt
--   FROM events e
--   WHERE e.status <> 'archived' AND e.signups_closed = false
--     AND e.capacity IS NOT NULL AND e.capacity > 0
--     AND event_confirmed_count(e.id) >= e.capacity;
--
-- Trigger-check (moet 1 rij returnen):
--   SELECT tgname FROM pg_trigger WHERE tgname = 'trg_event_attendees_auto_close';
