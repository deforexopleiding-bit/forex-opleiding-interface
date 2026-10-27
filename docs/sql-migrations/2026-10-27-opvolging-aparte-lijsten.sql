-- ============================================================================
-- Opvolging · Leads bellen — APARTE LIJSTEN
-- 27 oktober 2026
--
-- ⚠ NOG NIET GEDRAAID. Draai dit één keer in de Supabase SQL-editor van
-- forex-command-center. Idempotent: nogmaals draaien verandert niets.
--
-- NIET BLOKKEREND voor de bestaande flow: zonder deze tabel werkt "Lijst
-- opladen → Toevoegen aan algemene pot" exact zoals vandaag. Alleen de keuze
-- "Nieuwe aparte lijst" geeft dan een duidelijke melding (503,
-- code APARTE_LIJSTEN_NIET_ACTIEF) en schrijft niets.
--
-- Puur additief. Er wordt geen bestaande tabel, kolom, constraint, policy of
-- rij aangeraakt.
--
-- ── WAT HET DOET ────────────────────────────────────────────────────────────
-- 1. Nieuwe tabel opvolging_leads_lijsten: één rij per aparte lijst die in
--    Opvolging › Leads bellen via "Lijst opladen" gemaakt werd. Een lijst is
--    'actief' (eigen chip in de chiprij) tot iemand hem handmatig archiveert
--    ('gearchiveerd': chip weg, historiek blijft, terug te zetten).
-- 2. De kaarten zelf blijven gewone leadkaarten in opvolging_taken
--    (lijst='leads', bron='import'). De koppeling staat in
--    bron_ref->>'aparte_lijst_id' (bron_ref bestaat al, jsonb) — daarom is er
--    GEEN wijziging aan opvolging_taken nodig.
-- 3. Eén actieve lijst per naam (hoofdletterongevoelig), zodat er nooit twee
--    chips met dezelfde naam staan. Een gearchiveerde naam mag opnieuw.
-- 4. RLS volgens docs/rls-regels-nieuwe-tabellen.md: RLS aan + policy op
--    public.is_crm_staff(). De API schrijft met de service role.
--
-- ── CONTROLE NA ─────────────────────────────────────────────────────────────
--   SELECT relrowsecurity FROM pg_class WHERE oid = 'public.opvolging_leads_lijsten'::regclass;  -- true
--   SELECT policyname FROM pg_policies WHERE tablename = 'opvolging_leads_lijsten';           -- opvolging_leads_lijsten_staff
--   SELECT count(*) FROM public.opvolging_leads_lijsten;                                     -- 0
--
-- ── TERUGDRAAIEN ────────────────────────────────────────────────────────────
--   (De kaarten van aparte lijsten blijven bestaan; zonder tabel vallen ze
--    niet terug in de algemene pot, ze worden gewoon niet meer getoond.)
--   DROP TABLE IF EXISTS public.opvolging_leads_lijsten;
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.opvolging_leads_lijsten (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  naam               text NOT NULL,
  status             text NOT NULL DEFAULT 'actief',
  aangemaakt_door    uuid NULL,            -- auth.users.id; bewust geen FK (historiek blijft)
  gearchiveerd_at    timestamptz NULL,
  gearchiveerd_door  uuid NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opvolging_leads_lijsten_naam_chk   CHECK (char_length(btrim(naam)) BETWEEN 1 AND 60),
  CONSTRAINT opvolging_leads_lijsten_status_chk CHECK (status IN ('actief', 'gearchiveerd'))
);

COMMENT ON TABLE public.opvolging_leads_lijsten IS
  'Aparte bellijsten in Opvolging › Leads bellen (Lijst opladen → Nieuwe aparte lijst). '
  'Kaarten: opvolging_taken met bron_ref->>aparte_lijst_id = id. Archiveren = chip weg, kaarten blijven.';

CREATE UNIQUE INDEX IF NOT EXISTS opvolging_leads_lijsten_naam_actief_uq
  ON public.opvolging_leads_lijsten (lower(btrim(naam)))
  WHERE status = 'actief';

CREATE INDEX IF NOT EXISTS opvolging_leads_lijsten_status_idx
  ON public.opvolging_leads_lijsten (status, created_at DESC);

ALTER TABLE public.opvolging_leads_lijsten ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS opvolging_leads_lijsten_staff ON public.opvolging_leads_lijsten;
CREATE POLICY opvolging_leads_lijsten_staff
  ON public.opvolging_leads_lijsten
  FOR ALL
  TO authenticated
  USING      (public.is_crm_staff())
  WITH CHECK (public.is_crm_staff());
