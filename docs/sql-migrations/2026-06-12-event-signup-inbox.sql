-- =============================================================================
-- Events Module - inbound signup-brug (Fase 1)
-- =============================================================================
-- Datum: 2026-06-12
-- Branch: feat/events-signup-inbound
--
-- Doel: 1 nieuwe tabel `event_signup_inbox` voor INBOUND aanmeld-webhooks
-- (initieel GHL form-submits). Houdt elke binnenkomende payload vast voor
-- audit + manuele resolve, en linkt naar de gemaakte event_attendees-rij
-- zodra de reverse-lookup (formatEventLabel-match op `event_date_label`)
-- slaagt.
--
-- BEWUST GEEN wijziging aan `event_attendees`. Alle benodigde kolommen
-- (phone, email, first_name, last_name, ghl_contact_id, ghl_form_submission_id,
-- follow_up_flagged, follow_up_reason, created_via) bestaan al sinds F1 +
-- Blok 2 PR 3. needs_review-flag = follow_up_flagged + follow_up_reason.
--
-- FK-bronnen (pre-flight: hergebruik F1-events-foundation + PR 3):
--   public.events(id)
--   public.event_attendees(id)
--   auth.users(id)
--
-- match_status semantiek (CHECK):
--   'matched'           - 1 event-label-match -> attendee aangemaakt
--   'ambiguous'         - 2+ matches -> attendee bij EERSTE match + follow_up_flagged
--   'no_match'          - 0 matches -> geen attendee; admin moet resolven
--   'invalid_payload'   - payload-shape ongeldig (geen email/phone) -> review
--
-- Resolve-flow: admin (RBAC events.attendee.create) koppelt een no_match/
-- ambiguous-rij aan een event_id via /api/events-signup-inbox-resolve.
-- Daar wordt alsnog de attendee aangemaakt + resolved_at/by ingevuld.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.event_signup_inbox (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source                    text NOT NULL,
  raw_payload               jsonb NOT NULL,
  ghl_contact_id            text,
  ghl_form_submission_id    text,
  event_date_label          text,
  -- Captured fields uit de payload (denormalized voor admin-UI + dedup):
  first_name                text,
  last_name                 text,
  email                     text,
  phone                     text,
  -- Match-uitkomst:
  match_status              text NOT NULL
                              CHECK (match_status IN ('matched','ambiguous','no_match','invalid_payload')),
  matched_event_id          uuid REFERENCES public.events(id)        ON DELETE SET NULL,
  matched_attendee_id       uuid REFERENCES public.event_attendees(id) ON DELETE SET NULL,
  match_candidate_ids       uuid[],
  -- Resolve-trail (NULL tot een admin handmatig oplost):
  resolved_at               timestamptz,
  resolved_by_user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  notes                     text,
  -- Anti-abuse / debug:
  submitter_ip_hash         text,
  received_at               timestamptz NOT NULL DEFAULT now(),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- Lijstweergave voor admin: filter op status + sorteer op tijd.
CREATE INDEX IF NOT EXISTS idx_event_signup_inbox_status_received
  ON public.event_signup_inbox (match_status, received_at DESC);

-- Lookup van bestaande inbox-rijen per contact (idempotency-debugging).
CREATE INDEX IF NOT EXISTS idx_event_signup_inbox_ghl_contact
  ON public.event_signup_inbox (ghl_contact_id)
  WHERE ghl_contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_event_signup_inbox_email_lower
  ON public.event_signup_inbox (lower(email))
  WHERE email IS NOT NULL;

-- Rate-limit check op IP-hash (zelfde pattern als assessment_responses).
CREATE INDEX IF NOT EXISTS idx_event_signup_inbox_ip_recent
  ON public.event_signup_inbox (submitter_ip_hash, received_at DESC)
  WHERE submitter_ip_hash IS NOT NULL;

-- updated_at trigger (hergebruik set_updated_at() uit klanten-module).
DROP TRIGGER IF EXISTS trg_event_signup_inbox_updated_at ON public.event_signup_inbox;
CREATE TRIGGER trg_event_signup_inbox_updated_at
  BEFORE UPDATE ON public.event_signup_inbox
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.event_signup_inbox ENABLE ROW LEVEL SECURITY;
-- Geen policies - service_role bypassed RLS; API-laag enforced RBAC.
-- Lezers/schrijvers gaan exclusief via:
--   /api/events-signup-inbound      (publiek, secret-protected) -> INSERT
--   /api/events-signup-inbox-list   (sessie + RBAC)             -> SELECT
--   /api/events-signup-inbox-resolve(sessie + RBAC)             -> UPDATE

COMMIT;

-- =============================================================================
-- Smoke-test queries (run handmatig in Supabase SQL editor na deploy):
-- =============================================================================
-- 1) Tabel + CHECK + FKs aanwezig:
--    SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='event_signup_inbox'
--    ORDER BY ordinal_position;
--    -- verwacht: 21 kolommen.
--
--    SELECT conname, pg_get_constraintdef(oid)
--    FROM pg_constraint
--    WHERE conrelid='public.event_signup_inbox'::regclass
--    ORDER BY conname;
--    -- verwacht o.a.: event_signup_inbox_match_status_check + 3 FKs.
--
-- 2) Indexes:
--    SELECT indexname FROM pg_indexes
--    WHERE schemaname='public' AND tablename='event_signup_inbox';
--    -- verwacht: pkey + status_received + ghl_contact + email_lower + ip_recent
--
-- 3) RLS aan + 0 policies (correct):
--    SELECT relname, relrowsecurity FROM pg_class WHERE relname='event_signup_inbox';
--    -- verwacht: relrowsecurity = t
--    SELECT count(*) FROM pg_policies
--    WHERE schemaname='public' AND tablename='event_signup_inbox';
--    -- verwacht: 0 (service_role bypassed RLS)
-- =============================================================================
