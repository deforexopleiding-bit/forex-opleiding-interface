-- =============================================================================
-- Events Module Blok 2 - PR 1: Assessment foundation
-- =============================================================================
-- Datum: 2026-06-12
-- Branch: feat/events-blok2-assessment-foundation
--
-- Doel: Fundament voor het assessment (intake-vragenlijst) dat deelnemers VOOR
-- het event invullen. Deze PR levert CAPTURE-only:
--   - config-tabel met vragen (assessment_questions, gedreven door admin/SQL)
--   - response-tabel (assessment_responses) met status='submitted'
--   - publieke pagina + submit-endpoint
-- Geen routing, geen scoring, geen koppeling naar attendee/GHL in deze PR.
-- Volgende PR's voegen routing-engine (score+result) en outbound side-effects
-- toe.
--
-- FK-bronnen (pre-flight: hergebruik F1-events-foundation 2026-06-11):
--   public.events(id)              - migrations 2026-06-11-events-f1-foundation.sql
--   public.event_attendees(id)     - idem (assessment_response_id kolom bestaat)
--
-- Tabellen:
--   1. assessment_questions   - config / vragenlijst-bron (1 rij per veld)
--   2. assessment_responses   - 1 rij per ingevulde assessment-inzending
--
-- Hergebruik trigger:
--   public.set_updated_at() - gedefinieerd door klanten-module, gebruikt door F1.
--
-- RLS-pattern: service_role bypassed RLS. Public submit-endpoint gebruikt
-- supabaseAdmin (service role). Open SELECT-policy op assessment_questions
-- voor authenticated users (admin-UI in latere PR), publieke read via
-- API-endpoint dat zelf service_role gebruikt. Geen open SELECT op
-- assessment_responses (bevat PII van deelnemers).
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. assessment_questions - config-tabel
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.assessment_questions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key               text NOT NULL UNIQUE,
  section           text NOT NULL,
  order_index       integer NOT NULL DEFAULT 0,
  type              text NOT NULL
                       CHECK (type IN ('text','email','radio','scale_1_5','scale_1_10','open_text')),
  label             text NOT NULL,
  help_text         text,
  required          boolean NOT NULL DEFAULT true,
  options           jsonb,
  min_words         integer,
  is_routing        boolean NOT NULL DEFAULT false,
  routing_weights   jsonb,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assessment_questions_active_order
  ON public.assessment_questions (active, order_index);

DROP TRIGGER IF EXISTS trg_assessment_questions_updated_at ON public.assessment_questions;
CREATE TRIGGER trg_assessment_questions_updated_at
  BEFORE UPDATE ON public.assessment_questions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =============================================================================
-- 2. assessment_responses - 1 rij per ingevulde assessment
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.assessment_responses (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id            uuid REFERENCES public.events(id) ON DELETE SET NULL,
  email               text NOT NULL,
  first_name          text,
  last_name           text,
  answers             jsonb NOT NULL DEFAULT '{}'::jsonb,
  routing_result      text
                         CHECK (routing_result IS NULL OR routing_result IN ('basis','gevorderd','incomplete')),
  score               jsonb,
  status              text NOT NULL DEFAULT 'submitted'
                         CHECK (status IN ('submitted','processed','linked','archived')),
  ghl_contact_id      text,
  submitter_ip_hash   text,
  submitted_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assessment_responses_event
  ON public.assessment_responses (event_id)
  WHERE event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_assessment_responses_email_lower
  ON public.assessment_responses (lower(email));

CREATE INDEX IF NOT EXISTS idx_assessment_responses_ip_recent
  ON public.assessment_responses (submitter_ip_hash, submitted_at DESC)
  WHERE submitter_ip_hash IS NOT NULL;

DROP TRIGGER IF EXISTS trg_assessment_responses_updated_at ON public.assessment_responses;
CREATE TRIGGER trg_assessment_responses_updated_at
  BEFORE UPDATE ON public.assessment_responses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =============================================================================
-- 3. FK event_attendees.assessment_response_id -> assessment_responses.id
-- =============================================================================
-- De kolom bestaat al sinds F1 (idem migratie) als uuid zonder constraint.
-- Nu we de target-tabel hebben kunnen we de FK toevoegen. Idempotent: drop
-- bestaande versie + re-add met ON DELETE SET NULL (assessment kan los
-- bestaan zonder dat attendee meeverdwijnt - we willen attendee-rij
-- behouden voor historische rapportage als assessment-row wordt archived).
ALTER TABLE public.event_attendees
  DROP CONSTRAINT IF EXISTS event_attendees_assessment_response_id_fkey;
ALTER TABLE public.event_attendees
  ADD CONSTRAINT event_attendees_assessment_response_id_fkey
  FOREIGN KEY (assessment_response_id)
  REFERENCES public.assessment_responses(id)
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_event_attendees_assessment_response
  ON public.event_attendees (assessment_response_id)
  WHERE assessment_response_id IS NOT NULL;

-- =============================================================================
-- 4. RLS
-- =============================================================================
ALTER TABLE public.assessment_questions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assessment_responses  ENABLE ROW LEVEL SECURITY;

-- Open SELECT-policy op questions voor authenticated (admin-UI later).
-- Public read door API-endpoint dat self service_role gebruikt.
DROP POLICY IF EXISTS assessment_questions_read ON public.assessment_questions;
CREATE POLICY assessment_questions_read
  ON public.assessment_questions
  FOR SELECT
  TO authenticated
  USING (true);

-- Geen policies op assessment_responses - bevat PII. API-laag handelt
-- via service_role + RBAC ('events.assessment.*' keys in latere PR).

-- =============================================================================
-- 5. Seeds: 3 identiteit-velden + 9 v1-vragen
-- =============================================================================
-- routing_weights v1 (kalibreer later op echte data):
--   - hoge ervaring/handelen/winstgevend -> gevorderd
--   - lage motivatie functioneert als rem (negatieve weight bij <=3)
-- =============================================================================
INSERT INTO public.assessment_questions
  (key, section, order_index, type, label, help_text, required, options, min_words, is_routing, routing_weights, active)
VALUES
  -- Identiteit (3)
  ('voornaam', 'identiteit', 100, 'text',
   'Voornaam',
   NULL,
   true, NULL, NULL, false, NULL, true),

  ('achternaam', 'identiteit', 200, 'text',
   'Achternaam',
   NULL,
   true, NULL, NULL, false, NULL, true),

  ('email', 'identiteit', 300, 'email',
   'E-mailadres',
   'Hier ontvang je je persoonlijke uitslag en eventuele follow-up.',
   true, NULL, NULL, false, NULL, true),

  -- Routing-vragen (5)
  ('ervaring', 'routing', 400, 'radio',
   'Hoe lang ben je al bezig met traden?',
   NULL,
   true,
   '[
     {"value":"<3mnd",   "label":"Minder dan 3 maanden"},
     {"value":"3-12mnd", "label":"3 tot 12 maanden"},
     {"value":"1-2jr",   "label":"1 tot 2 jaar"},
     {"value":"2-5jr",   "label":"2 tot 5 jaar"},
     {"value":">5jr",    "label":"Meer dan 5 jaar"}
   ]'::jsonb,
   NULL, true,
   '{"<3mnd":0,"3-12mnd":1,"1-2jr":2,"2-5jr":3,">5jr":3}'::jsonb,
   true),

  ('handelen', 'routing', 500, 'radio',
   'Heb je al daadwerkelijk gehandeld?',
   NULL,
   true,
   '[
     {"value":"nog_niet","label":"Nog niet"},
     {"value":"demo",    "label":"Alleen op demo"},
     {"value":"live",    "label":"Live (met echt geld)"},
     {"value":"beide",   "label":"Beide (demo en live)"}
   ]'::jsonb,
   NULL, true,
   '{"nog_niet":0,"demo":1,"live":2,"beide":2}'::jsonb,
   true),

  ('tradeplan_risico', 'routing', 600, 'radio',
   'Werk je met een tradeplan en risicomanagement?',
   NULL,
   true,
   '[
     {"value":"nee",     "label":"Geen van beide"},
     {"value":"een",     "label":"Een van beide"},
     {"value":"allebei", "label":"Allebei"}
   ]'::jsonb,
   NULL, true,
   '{"nee":0,"een":1,"allebei":2}'::jsonb,
   true),

  ('winstgevend', 'routing', 700, 'radio',
   'Ben je al winstgevend?',
   NULL,
   true,
   '[
     {"value":"nog_niet",   "label":"Nog niet"},
     {"value":"af_en_toe",  "label":"Af en toe"},
     {"value":"consistent", "label":"Consistent winstgevend"}
   ]'::jsonb,
   NULL, true,
   '{"nog_niet":0,"af_en_toe":1,"consistent":2}'::jsonb,
   true),

  ('kennis', 'routing', 800, 'scale_1_5',
   'Hoe schat je je eigen forex-kennis in op een schaal van 1 t/m 5?',
   '1 = geen kennis, 5 = expert-niveau.',
   true, NULL, NULL, true,
   '{"1":0,"2":0,"3":1,"4":2,"5":2}'::jsonb,
   true),

  -- Engagement (3)
  ('motivatie', 'engagement', 900, 'scale_1_10',
   'Hoe gemotiveerd ben je om hier serieus tijd in te steken (1-10)?',
   'Eerlijk antwoord helpt ons om je passende begeleiding te bieden.',
   true, NULL, NULL, true,
   '{"1":-2,"2":-2,"3":-1,"4":0,"5":0,"6":0,"7":1,"8":1,"9":2,"10":2}'::jsonb,
   true),

  ('uitspraak', 'engagement', 1000, 'radio',
   'Welke uitspraak past het beste bij jou?',
   NULL,
   true,
   '[
     {"value":"gratis_info",        "label":"Ik ben op zoek naar gratis info"},
     {"value":"eerst_leren",        "label":"Ik wil eerst leren voordat ik investeer"},
     {"value":"investeer_bij_plan", "label":"Ik investeer zodra er een goed plan ligt"},
     {"value":"actief_begeleiding", "label":"Ik wil actief begeleid worden"}
   ]'::jsonb,
   NULL, false, NULL, true),

  ('grootste_uitdaging', 'engagement', 1100, 'open_text',
   'Wat is op dit moment je grootste uitdaging in trading?',
   'Minimaal 30 woorden - hoe specifieker, hoe beter we kunnen helpen.',
   true, NULL, 30, false, NULL, true),

  -- Doel (1)
  ('doel', 'doel', 1200, 'radio',
   'Wat is je belangrijkste doel?',
   NULL,
   true,
   '[
     {"value":"eerste_winstgevende_maand", "label":"Mijn eerste winstgevende maand draaien"},
     {"value":"funded_account",            "label":"Een funded account behalen"},
     {"value":"tweede_inkomen",            "label":"Een tweede inkomen opbouwen"},
     {"value":"voltijds_trader",           "label":"Voltijds trader worden"},
     {"value":"vermogen",                  "label":"Vermogen opbouwen op lange termijn"},
     {"value":"anders",                    "label":"Anders"}
   ]'::jsonb,
   NULL, false, NULL, true)
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- =============================================================================
-- Smoke-test queries (run handmatig in Supabase SQL editor na deploy):
-- =============================================================================
-- 1) Tabellen aanwezig:
--    SELECT table_name FROM information_schema.tables
--    WHERE table_schema='public' AND table_name LIKE 'assessment_%'
--    ORDER BY table_name;
--    -- verwacht: assessment_questions, assessment_responses
--
-- 2) 12 seeds aanwezig (3 identiteit + 9 v1-vragen):
--    SELECT count(*) FROM public.assessment_questions WHERE active=true;
--    -- verwacht: 12
--    SELECT section, count(*) FROM public.assessment_questions
--    WHERE active=true GROUP BY section ORDER BY section;
--    -- verwacht: doel=1, engagement=3, identiteit=3, routing=5
--
-- 3) FK op event_attendees actief:
--    SELECT conname FROM pg_constraint
--    WHERE conrelid='public.event_attendees'::regclass
--      AND conname='event_attendees_assessment_response_id_fkey';
--    -- verwacht: 1 rij
--
-- 4) RLS aan op beide:
--    SELECT relname, relrowsecurity FROM pg_class
--    WHERE relname IN ('assessment_questions','assessment_responses');
--    -- verwacht: beide relrowsecurity = t
-- =============================================================================
