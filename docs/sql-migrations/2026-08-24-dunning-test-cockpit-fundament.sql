-- 2026-08-24 · Dunning Test Cockpit — fundament (BLOK 1)
--
-- Voegt drie dingen toe die door productiepaden NIET worden gelezen:
--   1. test_cockpit_audit — append-only journal van cockpit-acties.
--   2. invoices.test_metadata (jsonb) — scenario-metadata voor testfacturen.
--   3. whatsapp_conversations.is_test — afgeleide vlag voor inbound routing
--      (wordt gezet door inbox-webhook zodra conv aan is_test-customer hangt).
--
-- Idempotent (IF NOT EXISTS overal). Geen productie-data mutatie.

BEGIN;

-- ── 1. Audit tabel ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.test_cockpit_audit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  triggered_by  uuid REFERENCES auth.users(id),
  admin_email   text,
  action        text NOT NULL,
  scope         text,
  target        jsonb DEFAULT '{}'::jsonb,
  payload       jsonb DEFAULT '{}'::jsonb,
  result        jsonb DEFAULT '{}'::jsonb,
  status        text NOT NULL,
  error_message text,
  created_at    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS test_cockpit_audit_created_idx
  ON public.test_cockpit_audit (created_at DESC);

-- ── 2. Test-metadata op invoices ────────────────────────────────────────────
-- Uitbreidbaar (scenario_tag, expected_outcome, created_by, ...) zonder
-- later nieuwe kolommen te hoeven bijprikken. Alleen gelezen door de cockpit.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS test_metadata jsonb DEFAULT NULL;

-- ── 3. is_test op whatsapp_conversations ────────────────────────────────────
-- Afgeleide vlag: fail-safe default false (onbekend = productie). Wordt door
-- inbox-webhook gezet bij match op customers.is_test of sandbox-nummer.
ALTER TABLE public.whatsapp_conversations
  ADD COLUMN IF NOT EXISTS is_test boolean DEFAULT false NOT NULL;
CREATE INDEX IF NOT EXISTS whatsapp_conversations_is_test_idx
  ON public.whatsapp_conversations (is_test) WHERE is_test = true;

DO $$
BEGIN
  RAISE NOTICE '── dunning test cockpit fundament ─────────────────';
  RAISE NOTICE '  test_cockpit_audit OK';
  RAISE NOTICE '  invoices.test_metadata OK';
  RAISE NOTICE '  whatsapp_conversations.is_test OK';
END $$;

COMMIT;
