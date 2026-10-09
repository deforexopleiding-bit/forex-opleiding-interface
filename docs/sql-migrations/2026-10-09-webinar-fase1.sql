-- 2026-10-09 · Webinar fase 1 — wekelijkse gratis webinar (elke maandag 19:00 NL).
--
-- WAAROM EIGEN TABELLEN (en geen events-rijen): een gepubliceerd event gaat
-- automatisch naar Webflow, de GHL-dropdown, de website_events-keuzelijst, de
-- belronde, het auto-sluiten 24u vooraf, en 6 event-automations met scope 'all'
-- (welkom/vragenlijst/warmup/reminders). Een webinar-aanmelder zou die
-- masterclass-berichten krijgen. Daarom: eigen tabellen, getoond als tab
-- "Webinar" in de Events-module.
--
--   webinar_reeksen       — de terugkerende reeks (weekdag, tijd, duur, Zoom-link)
--   webinar_sessies       — één rij per week (de week-instantie); 'overgeslagen' = geen webinar
--   webinar_aanmeldingen  — deelnemers per sessie + per moment "verstuurd op"
--   website_webinar_volgende (view) — publieke lijst komende actieve sessies, ZONDER Zoom-link
--
-- Sessies worden door de CRM aangemaakt (cron-webinar, elke 5 min: komende 6
-- weken). Geen harde limiet op aanmeldingen.
--
-- ⚠ BLOKKEREND: draai dit VÓÓR de merge van de CRM-PR (api/_lib/webinar.js,
-- api/public-webinar-aanmelding.js, api/cron-webinar.js en de tab lezen/schrijven
-- deze tabellen). Losse statements, in deze volgorde, in de Supabase SQL-editor.

-- ── 1. Reeks ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.webinar_reeksen (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  titel       text NOT NULL,
  weekdag     smallint NOT NULL CHECK (weekdag BETWEEN 1 AND 7),   -- ISO: 1 = maandag
  starttijd   time NOT NULL DEFAULT '19:00',                       -- NL-wandkloktijd
  duur_min    integer NOT NULL DEFAULT 60 CHECK (duur_min BETWEEN 15 AND 300),
  zoom_url    text,                                                -- vaste terugkerende Zoom-link
  actief      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── 2. Sessies (één per week) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.webinar_sessies (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reeks_id           uuid NOT NULL REFERENCES public.webinar_reeksen(id) ON DELETE CASCADE,
  datum              date NOT NULL,                                -- NL-kalenderdatum
  starts_at          timestamptz NOT NULL,
  ends_at            timestamptz NOT NULL,
  status             text NOT NULL DEFAULT 'gepland' CHECK (status IN ('gepland', 'overgeslagen')),
  zoom_url           text,                                         -- optioneel: afwijkende link voor deze week
  overgeslagen_op    timestamptz,
  overgeslagen_door  uuid,
  notitie            text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webinar_sessies_reeks_datum_uniek UNIQUE (reeks_id, datum),
  CONSTRAINT webinar_sessies_eind_na_start CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_webinar_sessies_start ON public.webinar_sessies (starts_at);

-- ── 3. Aanmeldingen ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.webinar_aanmeldingen (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sessie_id                 uuid NOT NULL REFERENCES public.webinar_sessies(id) ON DELETE CASCADE,
  lead_id                   uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  voornaam                  text,
  email                     text NOT NULL,
  telefoon                  text,                                  -- E.164 (+31…)
  bron                      text,                                  -- webinar-v1 / webinar-v2
  toestemming               boolean NOT NULL DEFAULT false,
  is_test                   boolean NOT NULL DEFAULT false,
  aangemeld_op              timestamptz NOT NULL DEFAULT now(),
  verplaatst_van_sessie_id  uuid REFERENCES public.webinar_sessies(id) ON DELETE SET NULL,
  -- Per moment: gezet bij het CLAIMEN (vóór versturen) → nooit dubbel.
  bevestiging_op            timestamptz,
  reminder_dag_op           timestamptz,
  reminder_uur_op           timestamptz,
  live_op                   timestamptz,
  berichten                 jsonb NOT NULL DEFAULT '{}'::jsonb,    -- per moment: { mail, wa } resultaat
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_webinar_aanmeldingen_sessie_email
  ON public.webinar_aanmeldingen (sessie_id, lower(email));
CREATE INDEX IF NOT EXISTS idx_webinar_aanmeldingen_lead ON public.webinar_aanmeldingen (lead_id);

-- ── 4. Alleen de service-role (CRM-API) mag erbij ────────────────────────────
ALTER TABLE public.webinar_reeksen      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webinar_sessies      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webinar_aanmeldingen ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.webinar_reeksen      FROM anon, authenticated;
REVOKE ALL ON public.webinar_sessies      FROM anon, authenticated;
REVOKE ALL ON public.webinar_aanmeldingen FROM anon, authenticated;

-- ── 5. Publieke view voor de website: komende ACTIEVE sessies, zonder Zoom-link ─
CREATE OR REPLACE VIEW public.website_webinar_volgende AS
SELECT s.id, r.titel, s.starts_at, s.ends_at
  FROM public.webinar_sessies s
  JOIN public.webinar_reeksen r ON r.id = s.reeks_id
 WHERE s.status = 'gepland'
   AND r.actief IS TRUE
   AND s.starts_at > now()
 ORDER BY s.starts_at;

GRANT SELECT ON public.website_webinar_volgende TO anon, authenticated;

-- ── 6. De maandag-reeks (Zoom-link vul je in via Events → Webinar) ──────────
INSERT INTO public.webinar_reeksen (slug, titel, weekdag, starttijd, duur_min, actief)
VALUES ('maandag', 'Gratis webinar De Forex Opleiding', 1, '19:00', 60, true)
ON CONFLICT (slug) DO NOTHING;

-- ── 7. Controle (alleen lezen) ───────────────────────────────────────────────
-- SELECT slug, titel, weekdag, starttijd, duur_min, actief, zoom_url IS NOT NULL AS heeft_zoom FROM public.webinar_reeksen;
-- Na de eerste cron-run (≤ 5 min na deploy): 6 komende maandagen.
-- SELECT datum, starts_at AT TIME ZONE 'Europe/Amsterdam' AS nl_start, status FROM public.webinar_sessies ORDER BY datum;
-- Verwacht: anon mag de tabellen NIET lezen, de view wel.
-- SELECT has_table_privilege('anon', 'public.webinar_aanmeldingen', 'SELECT') AS anon_tabel,  -- false
--        has_table_privilege('anon', 'public.website_webinar_volgende', 'SELECT') AS anon_view; -- true

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- DROP VIEW  IF EXISTS public.website_webinar_volgende;
-- DROP TABLE IF EXISTS public.webinar_aanmeldingen;
-- DROP TABLE IF EXISTS public.webinar_sessies;
-- DROP TABLE IF EXISTS public.webinar_reeksen;
