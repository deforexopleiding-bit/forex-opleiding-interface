-- 2026-09-15-events-belstatus-bevestigd-telt-mee.sql
--
-- Doel (Maxim, 15 sep 2026): wie in de eventmodule op belstatus "Bevestigd"
-- staat, neemt een plek in — ook zonder ingevulde vragenlijst. Bevestigd
-- overrult de vragenlijst voor de capaciteit.
--
-- Nieuwe "telt-mee"-regel (overal dezelfde):
--   status IN ('aangemeld','aanwezig')
--   AND is_test = false
--   AND ( assessment_response_id IS NOT NULL
--         OR lower(btrim(call_status)) = 'bevestigd' )
--
-- Gemeten vóór deze migratie (15 sep 2026, read-only):
--   19-09 Gent cap 8: nu 1 -> nieuw 5 (4 bevestigd zonder vragenlijst)
--   23-09 Gent cap 8: nu 3 -> nieuw 5
--   26-09 Gent cap 8: nu 6 -> nieuw 7
--   Geen enkel event raakt hierdoor vol -> geen automatische sluiting bij het draaien.
--   call_status-waarden: allemaal lowercase (bevestigd 74, leeg 75, komt_niet 19, ...)
--
-- Wat er gebeurt — puur additief / omkeerbaar, geen data geraakt:
--   1. NIEUWE overload event_attendee_is_confirmed(status, arId, is_test, call_status).
--      De oude 3-args-versie blijft bestaan (rollback), maar wordt nergens meer gebruikt.
--   2. event_confirmed_count(event_id) gebruikt de 4-args-versie.
--   3. fn_event_attendees_auto_close gebruikt de 4-args-versie voor de RISE-check,
--      en de trigger luistert nu ook op call_status.
--   4. View public.website_events (publieke site, anon): kolom bezet volgt de nieuwe regel.
--      Zelfde kolommen, zelfde types, grants blijven staan.
--   5. View ai_readonly.v_events_upcoming: plaatsen_over volgt de nieuwe regel;
--      aantal_vragenlijst_ingevuld blijft letterlijk "vragenlijst ingevuld";
--      nieuwe kolom achteraan: aantal_plek_bezet.
--
-- Volgorde: draaien NA de merge van de Node-kant (getConfirmedCount e.a.), zodat
-- DB-trigger en Node nooit een verschillende telling hanteren.
-- LET OP: de Supabase-editor draait alles als één transactie — geen begin/rollback-blokken.

-- ═══ 1. Predicate met belstatus ═════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.event_attendee_is_confirmed(
  p_status                 text,
  p_assessment_response_id uuid,
  p_is_test                boolean,
  p_call_status            text
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT p_status = ANY (ARRAY['aangemeld','aanwezig'])
     AND p_is_test = false
     AND ( p_assessment_response_id IS NOT NULL
           OR coalesce(lower(btrim(p_call_status)), '') = 'bevestigd' );
$$;

COMMENT ON FUNCTION public.event_attendee_is_confirmed(text, uuid, boolean, text) IS
  'Single source of truth voor "neemt een plek in" (sinds 2026-09-15): '
  'status aangemeld/aanwezig, is_test=false, en vragenlijst ingevuld OF belstatus bevestigd. '
  'Spiegel van Node isPlekBezet/getConfirmedCount in api/_lib/event-registration.js.';

COMMENT ON FUNCTION public.event_attendee_is_confirmed(text, uuid, boolean) IS
  'VEROUDERD sinds 2026-09-15 — enkel bewaard voor rollback. Gebruik de 4-args-versie met call_status.';

-- ═══ 2. Telling ══════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.event_confirmed_count(p_event_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT COUNT(*)::int
  FROM event_attendees
  WHERE event_id = p_event_id
    AND event_attendee_is_confirmed(status::text, assessment_response_id, is_test, call_status);
$$;

-- ═══ 3. Auto-close trigger ═══════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_event_attendees_auto_close()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_event_id          uuid;
  v_cap               integer;
  v_count             integer;
  v_rise_to_confirmed boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_event_id := NEW.event_id;
    v_rise_to_confirmed := event_attendee_is_confirmed(
      NEW.status::text, NEW.assessment_response_id, NEW.is_test, NEW.call_status);
  ELSIF TG_OP = 'UPDATE' THEN
    v_event_id := NEW.event_id;
    v_rise_to_confirmed :=
          event_attendee_is_confirmed(NEW.status::text, NEW.assessment_response_id, NEW.is_test, NEW.call_status)
      AND NOT event_attendee_is_confirmed(OLD.status::text, OLD.assessment_response_id, OLD.is_test, OLD.call_status);
  END IF;

  IF NOT v_rise_to_confirmed OR v_event_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT capacity INTO v_cap FROM events WHERE id = v_event_id;
  IF v_cap IS NULL OR v_cap <= 0 THEN
    RETURN NEW;
  END IF;

  v_count := event_confirmed_count(v_event_id);
  IF v_count < v_cap THEN
    RETURN NEW;
  END IF;

  UPDATE events
     SET signups_closed            = true,
         signups_closed_at         = now(),
         signups_closed_reason     = 'auto_full',
         signups_closed_by_user_id = NULL
   WHERE id             = v_event_id
     AND signups_closed = false
     AND capacity       IS NOT NULL
     AND capacity       > 0;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_event_attendees_auto_close ON public.event_attendees;
CREATE TRIGGER trg_event_attendees_auto_close
  AFTER INSERT OR UPDATE OF status, assessment_response_id, is_test, call_status
  ON public.event_attendees
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_event_attendees_auto_close();

-- ═══ 4. Publieke view (website) ══════════════════════════════════════════
CREATE OR REPLACE VIEW public.website_events AS
SELECT e.id,
    e.title AS titel,
    e.starts_at,
    e.ends_at,
    e.location AS locatie,
    e.niveau,
    e.capacity AS plekken,
    COALESCE(b.bezet, 0::bigint) AS bezet,
    GREATEST(e.capacity - COALESCE(b.bezet, 0::bigint), 0::bigint) AS vrij
   FROM events e
     LEFT JOIN ( SELECT a.event_id,
            count(*) AS bezet
           FROM event_attendees a
          WHERE a.is_test IS NOT TRUE
            AND (a.status = ANY (ARRAY['aangemeld'::event_attendee_status, 'aanwezig'::event_attendee_status]))
            AND (a.assessment_response_id IS NOT NULL
                 OR coalesce(lower(btrim(a.call_status)), '') = 'bevestigd')
          GROUP BY a.event_id) b ON b.event_id = e.id
  WHERE e.status = 'published'::text AND e.signups_closed IS NOT TRUE AND e.is_historical IS NOT TRUE AND e.starts_at > now()
  ORDER BY e.starts_at;

-- ═══ 5. AI-readonly view ═════════════════════════════════════════════════
CREATE OR REPLACE VIEW ai_readonly.v_events_upcoming AS
SELECT
  e.id                                              AS event_id,
  e.title,
  e.starts_at,
  e.ends_at,
  e.capacity,
  e.niveau,
  e.location,
  COUNT(a.id) FILTER (WHERE a.status IN ('aangemeld','aanwezig')
                        AND a.assessment_response_id IS NOT NULL
                        AND a.is_test = false)      AS aantal_vragenlijst_ingevuld,
  COUNT(a.id) FILTER (WHERE a.status IN ('aangemeld','aanwezig')
                        AND a.is_test = false)      AS aantal_ingeschreven,
  COUNT(a.id) FILTER (WHERE a.call_status IS NOT NULL
                        AND a.is_test = false)      AS aantal_gebeld,
  GREATEST(0, e.capacity - COUNT(a.id) FILTER (WHERE a.status IN ('aangemeld','aanwezig')
                        AND a.is_test = false
                        AND (a.assessment_response_id IS NOT NULL
                             OR coalesce(lower(btrim(a.call_status)), '') = 'bevestigd'))) AS plaatsen_over,
  -- predicate hier inline (geen functie-aanroep) zodat de rol ai_readonly geen EXECUTE-recht nodig heeft
  COUNT(a.id) FILTER (WHERE a.status IN ('aangemeld','aanwezig')
                        AND a.is_test = false
                        AND (a.assessment_response_id IS NOT NULL
                             OR coalesce(lower(btrim(a.call_status)), '') = 'bevestigd')) AS aantal_plek_bezet
FROM public.events e
LEFT JOIN public.event_attendees a ON a.event_id = e.id
WHERE e.status = 'published'
  AND e.starts_at >= now()
GROUP BY e.id, e.title, e.starts_at, e.ends_at, e.capacity, e.niveau, e.location
ORDER BY e.starts_at ASC;

-- ═══ Verificatie (na het draaien) ════════════════════════════════════════
--   SELECT e.title, e.starts_at, e.capacity, event_confirmed_count(e.id) AS bezet,
--          w.bezet AS website_bezet, e.signups_closed
--   FROM events e LEFT JOIN website_events w ON w.id = e.id
--   WHERE e.starts_at > now() ORDER BY e.starts_at;
--   -> verwacht 19-09: 5, 23-09: 5, 26-09: 7 en bezet = website_bezet
--   SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = 'trg_event_attendees_auto_close';
--   -> moet call_status in de kolomlijst hebben
--
-- ═══ Rollback ═══════════════════════════════════════════════════════════
--   1. event_confirmed_count terug naar de 3-args-predicate:
--      ... AND event_attendee_is_confirmed(status::text, assessment_response_id, is_test);
--   2. fn_event_attendees_auto_close: de versie uit 2026-08-18-events-auto-close-trigger.sql
--   3. Trigger: AFTER INSERT OR UPDATE OF status, assessment_response_id, is_test
--   4. website_events: de OR ... call_status-regel weghalen
--   5. v_events_upcoming: kan niet via CREATE OR REPLACE een kolom verliezen —
--      plaatsen_over terugzetten en aantal_plek_bezet laten staan (onschadelijk).
