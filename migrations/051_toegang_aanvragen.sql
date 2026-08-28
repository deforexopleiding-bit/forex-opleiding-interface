-- ============================================================================
-- Migratie 051: WhatsApp-gate voor 7-daagse + mini-cursus toegang
-- Datum: 2026-08-28
-- Doel:  registratie + state-machine voor de "WhatsApp-bevestiging vóór inlog"-
--        flow. Gekwalificeerde 7-daagse/mini leads krijgen NIET meer direct
--        LMS-toegang; ze krijgen eerst een WhatsApp-bevestiging + reminders,
--        en pas na een reactie (inbound WA) wordt de dfo-website provisioning
--        aangeroepen die inlog + welkomstmail regelt.
--
-- State-machine (kolom `status`):
--   'wachtend'    — aanvraag binnengekomen, wachten op reactie
--   'gereageerd'  — inbound WA-reply gedetecteerd; provisioning gestart
--   'vervallen'   — geen reactie binnen X uur na 48u-reminder
--
-- Timestamp-kolommen dienen als guard-triggers voor de cron (idempotent):
--   bevestiging_sent_at — ~2 min na created_at
--   reminder_2u_at      — bevestiging + 2u
--   reminder_24u_at     — bevestiging + 24u
--   reminder_48u_at     — bevestiging + 48u
--   reacted_at          — inbound WA match
--   provisioned_at      — HARDE idempotency: precies 1x aangeroepen dfo-website
--   dag6_sent_at        — check-in 6 dagen na provisioning (alleen 7-daagse)
--   vervallen_at        — timeout na 48u-reminder
--
-- Idempotent: CREATE TABLE IF NOT EXISTS. Herhaalde run = no-op.
-- 0 incasso-writes. Incasso-zone onaangeroerd.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.toegang_aanvragen (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at            timestamptz NOT NULL DEFAULT now(),

  -- Cursus + funnel-bron
  soort                 text NOT NULL CHECK (soort IN ('7-daagse', 'minicursus')),
  bron                  text,

  -- Contact
  voornaam              text,
  email                 text NOT NULL,
  telefoon              text NOT NULL,   -- E.164 verwacht

  -- Flow-A/B discriminator: al een call geboekt in de funnel?
  call_geboekt          boolean NOT NULL DEFAULT false,

  -- State-machine
  status                text NOT NULL DEFAULT 'wachtend'
                          CHECK (status IN ('wachtend', 'gereageerd', 'vervallen')),

  -- Cron-timers (elk NULL tot verstuurd)
  bevestiging_sent_at   timestamptz,
  reminder_2u_at        timestamptz,
  reminder_24u_at       timestamptz,
  reminder_48u_at       timestamptz,

  -- Reactie + provisioning
  reacted_at            timestamptz,
  provisioned_at        timestamptz,   -- guard tegen dubbele inlogmail
  provisioned_error     text,          -- fail-soft: laatste error als dfo-website faalt
  vervallen_at          timestamptz,

  -- Alleen 7-daagse: dag-6 check-in
  dag6_sent_at          timestamptz,

  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.toegang_aanvragen IS 'WhatsApp-gate voor 7-daagse + mini-cursus. Gekwalificeerde leads krijgen pas LMS-toegang na een WA-reactie. Zie CRM-cron cron-toegang-aanvragen + follow-up-ghl-conversation-webhook.';
COMMENT ON COLUMN public.toegang_aanvragen.call_geboekt  IS 'Bepaalt template-variant A (call al geboekt) of B (call nog niet geboekt, met agenda-link).';
COMMENT ON COLUMN public.toegang_aanvragen.provisioned_at IS 'HARDE idempotency-guard. Zodra gezet: geen tweede provisioning-call meer richting dfo-website. Voorkomt dubbele inlogmail bij een tweede WA-reply.';
COMMENT ON COLUMN public.toegang_aanvragen.dag6_sent_at   IS 'Alleen voor 7-daagse. Zes dagen na provisioning: WA-check-in of ze het spannend vinden (variant A/B).';

-- Indexen voor de cron-scans + monitoring-tab filters.
CREATE INDEX IF NOT EXISTS idx_toegang_aanvragen_status
  ON public.toegang_aanvragen (status);
CREATE INDEX IF NOT EXISTS idx_toegang_aanvragen_telefoon
  ON public.toegang_aanvragen (telefoon);
CREATE INDEX IF NOT EXISTS idx_toegang_aanvragen_created_at
  ON public.toegang_aanvragen (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_toegang_aanvragen_wachtend_bevestiging
  ON public.toegang_aanvragen (created_at)
  WHERE status = 'wachtend' AND bevestiging_sent_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_toegang_aanvragen_wachtend_reminder
  ON public.toegang_aanvragen (bevestiging_sent_at)
  WHERE status = 'wachtend' AND bevestiging_sent_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_toegang_aanvragen_dag6
  ON public.toegang_aanvragen (provisioned_at)
  WHERE status = 'gereageerd' AND provisioned_at IS NOT NULL AND dag6_sent_at IS NULL AND soort = '7-daagse';

-- Auto-touch updated_at.
CREATE OR REPLACE FUNCTION public._toegang_aanvragen_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_toegang_aanvragen_touch ON public.toegang_aanvragen;
CREATE TRIGGER trg_toegang_aanvragen_touch
  BEFORE UPDATE ON public.toegang_aanvragen
  FOR EACH ROW EXECUTE FUNCTION public._toegang_aanvragen_touch();

-- RLS: authenticated read (zoals rest van Leadsonderhoud); writes via service_role.
ALTER TABLE public.toegang_aanvragen ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS toegang_aanvragen_read ON public.toegang_aanvragen;
CREATE POLICY toegang_aanvragen_read ON public.toegang_aanvragen
  FOR SELECT TO authenticated
  USING (true);

COMMIT;

-- ============================================================================
-- VERIFICATIE (draai NA COMMIT)
-- ============================================================================
-- 1. Tabel + kolommen:
--    SELECT column_name, data_type, is_nullable
--      FROM information_schema.columns
--     WHERE table_schema='public' AND table_name='toegang_aanvragen'
--     ORDER BY ordinal_position;
--
-- 2. RLS aan + read-policy:
--    SELECT relrowsecurity FROM pg_class WHERE relname='toegang_aanvragen';
--    SELECT policyname, cmd, roles FROM pg_policies WHERE tablename='toegang_aanvragen';
--
-- 3. Indexen:
--    SELECT indexname FROM pg_indexes WHERE tablename='toegang_aanvragen';
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- BEGIN;
--   DROP TABLE IF EXISTS public.toegang_aanvragen;
--   DROP FUNCTION IF EXISTS public._toegang_aanvragen_touch();
-- COMMIT;
-- ============================================================================
