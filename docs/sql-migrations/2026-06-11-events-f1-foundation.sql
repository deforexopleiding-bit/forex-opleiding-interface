-- =============================================================================
-- Events Module — F1 Foundation
-- =============================================================================
-- Datum: 2026-06-11
-- Branch: feat/events-f1-foundation
--
-- Doel: Fundament voor de Events-module (workshops / live-trainingen).
-- 7 tabellen + 1 ENUM + seeds + RLS-policies.
--
-- Tabellen:
--   1. event_niveau_options       — referentie-tabel voor niveau-slugs
--   2. events                     — workshop / training records
--   3. event_mentors              — N:M koppeling event ↔ team_members
--   4. event_attendees            — deelnemers per event
--   5. event_attendee_audit_log   — wijzigingshistorie per deelnemer
--   6. event_tags_catalog         — beschikbare tags voor deelnemers
--   7. event_attendee_tags        — N:M koppeling deelnemer ↔ tag
--
-- ENUM:
--   event_attendee_status (aangemeld, aanwezig, no_show, sale, switched_to_other_event)
--
-- FK-bronnen (pre-flight geverifieerd 2026-06-11):
--   public.customers(id)      — migrations/012_klanten_module_foundation.sql
--   public.deals(id)          — docs/sql-migrations/2026-05-30-finance-fase-1-fundament.sql
--   public.subscriptions(id)  — docs/sql-migrations/2026-05-30-finance-fase-1-fundament.sql
--   public.team_members(id)   — api/db-migrate-batch-meetings.js
--   auth.users(id)            — Supabase Auth (standaard)
--
-- Hergebruik: deze migratie hergebruikt public.set_updated_at() trigger-functie
-- uit de klanten-module migratie (migrations/012_klanten_module_foundation.sql).
-- Die functie zet NEW.updated_at = now() bij elke UPDATE. Geen redefinitie nodig.
--
-- RLS-pattern: service_role (backend Supabase clients) bypassed RLS, dus API-laag
-- enforced RBAC via FEATURE_REGISTRY ('events.*' keys in admin.html).
-- Voor de 2 referentie-tabellen (niveau-options + tags-catalog) staat een
-- SELECT-policy open voor authenticated users — dat is statische lookup-data.
-- =============================================================================

BEGIN;

-- ── 1. ENUM event_attendee_status ──────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'event_attendee_status') THEN
    CREATE TYPE public.event_attendee_status AS ENUM (
      'aangemeld',
      'aanwezig',
      'no_show',
      'sale',
      'switched_to_other_event'
    );
  END IF;
END$$;

-- ── 2. event_niveau_options ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.event_niveau_options (
  slug         text PRIMARY KEY,
  label        text NOT NULL,
  sort_order   integer NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_event_niveau_options_updated_at ON public.event_niveau_options;
CREATE TRIGGER trg_event_niveau_options_updated_at
  BEFORE UPDATE ON public.event_niveau_options
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.event_niveau_options (slug, label, sort_order)
VALUES
  ('basis',     'Basis',     10),
  ('gevorderd', 'Gevorderd', 20)
ON CONFLICT (slug) DO NOTHING;

-- ── 3. events ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.events (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title                    text NOT NULL,
  starts_at                timestamptz NOT NULL,
  ends_at                  timestamptz,
  location                 text,
  capacity                 integer NOT NULL CHECK (capacity > 0),
  status                   text NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft','published','cancelled','archived')),
  niveau                   text REFERENCES public.event_niveau_options(slug)
                              ON UPDATE CASCADE,
  description_md           text,
  webflow_item_id          text,
  webflow_sync_status      text,
  webflow_last_synced_at   timestamptz,
  ghl_sync_status          text,
  ghl_last_synced_at       timestamptz,
  created_by_user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT events_ends_after_starts CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_events_status_starts
  ON public.events (status, starts_at);

CREATE INDEX IF NOT EXISTS idx_events_niveau_starts_published
  ON public.events (niveau, starts_at)
  WHERE status = 'published';

DROP TRIGGER IF EXISTS trg_events_updated_at ON public.events;
CREATE TRIGGER trg_events_updated_at
  BEFORE UPDATE ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── 4. event_mentors ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.event_mentors (
  event_id          uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  team_member_id    uuid NOT NULL REFERENCES public.team_members(id) ON DELETE RESTRICT,
  added_at          timestamptz NOT NULL DEFAULT now(),
  added_by_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (event_id, team_member_id)
);

CREATE INDEX IF NOT EXISTS idx_event_mentors_team_member
  ON public.event_mentors (team_member_id);

-- ── 5. event_attendees ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.event_attendees (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                  uuid NOT NULL REFERENCES public.events(id) ON DELETE RESTRICT,
  first_name                text,
  last_name                 text,
  email                     text,
  phone                     text,
  status                    public.event_attendee_status NOT NULL DEFAULT 'aangemeld',
  customer_id               uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  deal_id                   uuid REFERENCES public.deals(id) ON DELETE SET NULL,
  subscription_id           uuid REFERENCES public.subscriptions(id) ON DELETE SET NULL,
  ghl_contact_id            text,
  ghl_form_submission_id    text,
  assessment_response_id    uuid,
  switched_from_event_id    uuid REFERENCES public.events(id) ON DELETE SET NULL,
  switched_at               timestamptz,
  registered_at             timestamptz NOT NULL DEFAULT now(),
  attended_at               timestamptz,
  no_show_marked_at         timestamptz,
  sale_at                   timestamptz,
  follow_up_flagged         boolean NOT NULL DEFAULT false,
  follow_up_reason          text,
  created_by_user_id        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- Email-uniqueness per event (case-insensitive, alleen non-null emails).
-- PARTIAL UNIQUE INDEX in plaats van EXCLUDE-constraint zodat we
-- btree_gist niet als extensie-dependency hebben.
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_attendees_event_email
  ON public.event_attendees (event_id, lower(email))
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_event_attendees_event_status
  ON public.event_attendees (event_id, status);

CREATE INDEX IF NOT EXISTS idx_event_attendees_customer
  ON public.event_attendees (customer_id)
  WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_event_attendees_deal
  ON public.event_attendees (deal_id)
  WHERE deal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_event_attendees_event_phone
  ON public.event_attendees (event_id, phone)
  WHERE phone IS NOT NULL;

DROP TRIGGER IF EXISTS trg_event_attendees_updated_at ON public.event_attendees;
CREATE TRIGGER trg_event_attendees_updated_at
  BEFORE UPDATE ON public.event_attendees
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── 6. event_attendee_audit_log ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.event_attendee_audit_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attendee_id   uuid NOT NULL REFERENCES public.event_attendees(id) ON DELETE CASCADE,
  action        text NOT NULL,
  before_state  jsonb,
  after_state   jsonb,
  by_user_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_attendee_audit_log_attendee_at
  ON public.event_attendee_audit_log (attendee_id, at DESC);

-- ── 7. event_tags_catalog ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.event_tags_catalog (
  slug         text PRIMARY KEY,
  label        text NOT NULL,
  color        text,
  description  text,
  is_system    boolean NOT NULL DEFAULT false,
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.event_tags_catalog (slug, label, color, description, is_system, sort_order)
VALUES
  ('event-no-show',          'Event no-show',           '#EF4444', 'Aangemeld maar niet verschenen op de workshop.',                              true,  10),
  ('assessment-incompleet',  'Assessment incompleet',   '#F59E0B', 'Assessment ontbreekt of niet volledig ingevuld voor het event.',              true,  20),
  ('mismatch-followup',      'Mismatch follow-up',      '#A855F7', 'Niveau / profiel-mismatch — vereist follow-up door sales.',                   true,  30),
  ('sale-confirmed',         'Sale bevestigd',          '#10B981', 'Deelnemer heeft tijdens of na het event een sale gedaan.',                    true,  40),
  ('switched',               'Doorgeschoven',           '#3B82F6', 'Deelnemer is doorgeschoven naar een ander event.',                            true,  50),
  ('vip',                    'VIP',                     '#EAB308', 'VIP-deelnemer — extra aandacht / persoonlijke benadering.',                   false, 60)
ON CONFLICT (slug) DO NOTHING;

-- ── 8. event_attendee_tags ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.event_attendee_tags (
  attendee_id       uuid NOT NULL REFERENCES public.event_attendees(id) ON DELETE CASCADE,
  tag_slug          text NOT NULL REFERENCES public.event_tags_catalog(slug) ON DELETE RESTRICT,
  added_at          timestamptz NOT NULL DEFAULT now(),
  added_by_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  source            text NOT NULL DEFAULT 'manual'
                      CHECK (source IN ('system','manual','automation')),
  source_ref        text,
  PRIMARY KEY (attendee_id, tag_slug)
);

CREATE INDEX IF NOT EXISTS idx_event_attendee_tags_tag
  ON public.event_attendee_tags (tag_slug);

-- ── 9. Row Level Security ──────────────────────────────────────────────────────
ALTER TABLE public.event_niveau_options       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_mentors              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_attendees            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_attendee_audit_log   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_tags_catalog         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_attendee_tags        ENABLE ROW LEVEL SECURITY;

-- Open SELECT-policy op referentie-tabellen (statische lookup-data).
DROP POLICY IF EXISTS events_niveau_options_read ON public.event_niveau_options;
CREATE POLICY events_niveau_options_read
  ON public.event_niveau_options
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS events_tags_catalog_read ON public.event_tags_catalog;
CREATE POLICY events_tags_catalog_read
  ON public.event_tags_catalog
  FOR SELECT
  TO authenticated
  USING (true);

-- Geen verdere policies. service_role (backend Supabase clients) bypassed RLS;
-- API-laag enforced RBAC via FEATURE_REGISTRY ('events.*' keys in admin.html).
-- Anon / authenticated kunnen zonder service_role-token niets lezen/muteren op
-- de overige 5 tabellen.

COMMIT;

-- =============================================================================
-- Smoke-test queries (run handmatig in Supabase SQL editor na deploy):
-- =============================================================================
-- 1) Tabellen aanwezig:
--    SELECT table_name FROM information_schema.tables
--    WHERE table_schema='public' AND table_name LIKE 'event%'
--    ORDER BY table_name;
--    -- verwacht: 7 rijen
--
-- 2) ENUM aanwezig:
--    SELECT typname, enumlabel
--    FROM pg_enum e
--    JOIN pg_type t ON t.oid = e.enumtypid
--    WHERE typname='event_attendee_status'
--    ORDER BY enumsortorder;
--    -- verwacht: 5 rijen (aangemeld, aanwezig, no_show, sale, switched_to_other_event)
--
-- 3) Seeds aanwezig:
--    SELECT slug, label FROM public.event_niveau_options ORDER BY sort_order;
--    -- verwacht: basis, gevorderd
--    SELECT slug, label, is_system FROM public.event_tags_catalog ORDER BY sort_order;
--    -- verwacht: 6 rijen waarvan 5 system + 1 vip non-system
--
-- 4) RLS-policies open op referentie-tabellen:
--    SELECT polname, tablename FROM pg_policies WHERE schemaname='public'
--    AND tablename IN ('event_niveau_options','event_tags_catalog');
--    -- verwacht: 2 SELECT-policies
-- =============================================================================
