-- ============================================================================
-- Migratie 047: Opstartsessie-submissions (DEEL 3 van Opstartsessie-project)
-- Datum: 2026-08-27
-- Doel:  vastleggen wat elke lead op de publieke Opstartsessie-pagina doet —
--        incl. afgewezen leads (die geen afspraak boeken). Backoffice-inzage
--        in Leadsonderhoud → Opstartsessies-tab (DEEL 3-C).
--
-- Bewust ontwerp:
--   - Eén rij per submission (form-invoer moment); niet per klik.
--   - antwoorden JSONB als canonieke shape [{ vraag, gekozen_label, punten,
--     afwijzer }] — zelfde volgorde als de vragenlijst.
--   - resultaat is een 2-waarden enum via CHECK ('toegelaten' / 'afgewezen').
--   - noshow_akkoord + appointment_id + lead_id worden pas gezet ná book;
--     bij afgewezen leads blijven ze NULL — die submission is dan finaal.
--   - appointment_id / lead_id: FK naar bestaande tabellen met ON DELETE SET
--     NULL zodat verwijderen van appointment/lead deze audit-rij niet stuk
--     maakt (submission = historische snapshot, mag ouder zijn dan de FK).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS,
-- DROP POLICY IF EXISTS + CREATE POLICY. Herhaalde run = no-op.
--
-- 0 incasso-writes. Incasso-zone (finance.html, *dunning*, *arrangement*,
-- pending-action*, _lib/dunning-*) onaangeroerd.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.opstartsessie_submissions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        timestamptz NOT NULL DEFAULT now(),

  -- Bron uit de link (rauwe slug, mag onbekend/typo zijn — telbaar houden).
  booking_source    text,

  -- Contactgegevens (zoals ingevuld op de pagina; kan afwijken van lead-row
  -- als 'ie daarna via upsert_lead genormaliseerd is).
  naam              text,
  email             text,
  telefoon          text,

  -- Gekozen moment. Leesbaar voor Jeffrey ("ma 31 aug om 14:00") + optionele
  -- ISO-timestamp als de proxy 'em meestuurt.
  gekozen_slot      text,
  gekozen_start_at  timestamptz,

  -- Vragenlijst-antwoorden + scoring-snapshot (frozen op moment van submit).
  antwoorden        jsonb NOT NULL DEFAULT '[]'::jsonb,
  score             integer,
  drempel           integer,

  -- Uitkomst — enum-achtig via CHECK (twee waarden).
  resultaat         text NOT NULL CHECK (resultaat IN ('toegelaten', 'afgewezen')),

  -- Vervolgstappen — NULL zolang de lead niet het akkoord + boek-flow heeft
  -- doorlopen. Bij afgewezen leads blijven ze NULL (geen appointment mogelijk).
  noshow_akkoord    boolean NOT NULL DEFAULT false,
  appointment_id    uuid REFERENCES public.follow_up_appointments(id) ON DELETE SET NULL,
  lead_id           uuid REFERENCES public.leads(id)                   ON DELETE SET NULL
);

COMMENT ON TABLE public.opstartsessie_submissions IS 'Ruwe submissions van de publieke Opstartsessie-pagina (deforexopleiding.nl/opstartsessie/<slug>). Eén rij per ingevuld formulier — óók afgewezen leads. Backoffice-inzage via Leadsonderhoud → Opstartsessies-tab.';
COMMENT ON COLUMN public.opstartsessie_submissions.antwoorden      IS 'JSONB array [{ vraag, gekozen_label, punten, afwijzer }] in volgorde van de vragenlijst. Frozen snapshot op submit-moment (immuun voor latere editor-wijzigingen).';
COMMENT ON COLUMN public.opstartsessie_submissions.resultaat       IS 'toegelaten = score >= drempel én geen afwijzer; afgewezen = één afwijzer-antwoord OF score < drempel.';
COMMENT ON COLUMN public.opstartsessie_submissions.noshow_akkoord  IS 'True zodra de lead het €50-no-show-vinkje heeft aangevinkt EN de boek-endpoint heeft aangeroepen. Bij afgewezen leads / afhakers = false.';
COMMENT ON COLUMN public.opstartsessie_submissions.appointment_id  IS 'FK naar follow_up_appointments — alleen gevuld als de lead na akkoord daadwerkelijk een slot heeft geboekt. ON DELETE SET NULL zodat submission-audit blijft bestaan.';
COMMENT ON COLUMN public.opstartsessie_submissions.lead_id         IS 'FK naar leads — gevuld door book-endpoint via upsert_lead. Bij afgewezen submission-only = NULL.';

-- Indexen voor de backoffice-lijst (nieuwste eerst) + filters.
CREATE INDEX IF NOT EXISTS idx_opstartsessie_submissions_created_at
  ON public.opstartsessie_submissions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_opstartsessie_submissions_booking_source
  ON public.opstartsessie_submissions (booking_source)
  WHERE booking_source IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_opstartsessie_submissions_resultaat
  ON public.opstartsessie_submissions (resultaat);
CREATE INDEX IF NOT EXISTS idx_opstartsessie_submissions_appointment_id
  ON public.opstartsessie_submissions (appointment_id)
  WHERE appointment_id IS NOT NULL;

-- ── RLS: authenticated read-all; writes via service_role ─────────────────
ALTER TABLE public.opstartsessie_submissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS opstartsessie_submissions_read ON public.opstartsessie_submissions;
CREATE POLICY opstartsessie_submissions_read ON public.opstartsessie_submissions
  FOR SELECT TO authenticated
  USING (true);

-- Writes gaan via supabaseAdmin (service-role) in api/public-opstartsessie-*
-- en api/leadsonderhoud-opstartsessies-*. RBAC-gate zit in de endpoints
-- (internal-token voor publieke submit/book, leads.view voor CRM-inzage).

COMMIT;

-- ============================================================================
-- VERIFICATIE (draai NA COMMIT)
-- ============================================================================
-- 1. Tabel + kolommen:
--    SELECT column_name, data_type, is_nullable
--      FROM information_schema.columns
--     WHERE table_schema='public' AND table_name='opstartsessie_submissions'
--     ORDER BY ordinal_position;
--    Verwacht: 13 kolommen (id, created_at, booking_source, naam, email,
--    telefoon, gekozen_slot, gekozen_start_at, antwoorden, score, drempel,
--    resultaat, noshow_akkoord, appointment_id, lead_id).
--
-- 2. RLS staat aan:
--    SELECT relrowsecurity FROM pg_class WHERE relname='opstartsessie_submissions';
--    Verwacht: true.
--
-- 3. Read-policy:
--    SELECT policyname, cmd, roles FROM pg_policies
--     WHERE tablename='opstartsessie_submissions';
--    Verwacht: opstartsessie_submissions_read | SELECT | {authenticated}.
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- BEGIN;
--   DROP TABLE IF EXISTS public.opstartsessie_submissions;
-- COMMIT;
-- ============================================================================
