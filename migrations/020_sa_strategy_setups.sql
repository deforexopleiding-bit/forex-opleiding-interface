-- ──────────────────────────────────────────────────────────────────────────────
-- Migratie 020: Strategie-trainer — bibliotheek van FMES-setup-screenshots
-- ──────────────────────────────────────────────────────────────────────────────
-- Owner labelt geüploade screenshots (goed voorbeeld / tegenvoorbeeld) om een
-- bibliotheek te bouwen als fundering voor latere AI-analyse.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, indexes idem, policies via
-- DROP … IF EXISTS + CREATE, bucket via INSERT … ON CONFLICT DO NOTHING.
-- Meerdere keren draaien = niks stuk.
--
-- Beveiliging:
--   • RLS AAN op public.sa_setups met owner-policy (user_id = auth.uid()).
--   • PRIVATE storage-bucket 'sa-strategy-setups' — nooit publiek. Toegang
--     alleen via signed URLs vanuit de owner-gated endpoints (service-role).
--   • Extra storage-policies (defense-in-depth) beperken authenticated toegang
--     tot de eigen map ({user_id}/…). Service-role bypasst RLS sowieso.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS public.sa_setups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  user_id       uuid NOT NULL,
  model         text CHECK (model IS NULL OR model IN ('confirmation', 'continuation', 'range_break')),
  is_positive   boolean NOT NULL DEFAULT true,   -- true = goed voorbeeld, false = tegenvoorbeeld
  instrument    text,
  timeframe     text,
  setup_date    date,
  elements      jsonb NOT NULL DEFAULT '{}'::jsonb,  -- { sweep, displacement, mss, fib_071, ob, volume_gap, h4_bias, entry, sl, tp }
  description   text NOT NULL DEFAULT '',
  storage_path  text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sa_setups_user    ON public.sa_setups (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sa_setups_model   ON public.sa_setups (model);
CREATE INDEX IF NOT EXISTS idx_sa_setups_positive ON public.sa_setups (is_positive);
CREATE INDEX IF NOT EXISTS idx_sa_setups_instr   ON public.sa_setups (instrument);

-- RLS: alleen eigen rijen (user_id = auth.uid()). Eén FOR ALL-policy dekt
-- select/insert/update/delete. Endpoints draaien op service-role (bypass) én
-- filteren zelf op user_id — twee lagen.
ALTER TABLE public.sa_setups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sa_setups_owner_all" ON public.sa_setups;
CREATE POLICY "sa_setups_owner_all" ON public.sa_setups
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- PRIVATE storage-bucket. public = false → geen publieke URL's; alles via
-- signed URLs uit de endpoints.
INSERT INTO storage.buckets (id, name, public)
VALUES ('sa-strategy-setups', 'sa-strategy-setups', false)
ON CONFLICT (id) DO NOTHING;

-- Defense-in-depth: authenticated mag alleen in de eigen map
-- ({user_id}/…). Service-role (endpoints) bypasst dit.
DROP POLICY IF EXISTS "sa_setups_obj_select" ON storage.objects;
CREATE POLICY "sa_setups_obj_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'sa-strategy-setups' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "sa_setups_obj_insert" ON storage.objects;
CREATE POLICY "sa_setups_obj_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'sa-strategy-setups' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "sa_setups_obj_delete" ON storage.objects;
CREATE POLICY "sa_setups_obj_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'sa-strategy-setups' AND (storage.foldername(name))[1] = auth.uid()::text);

COMMIT;

-- Rollback (handmatig, defensief):
-- DROP TABLE IF EXISTS public.sa_setups;
-- DELETE FROM storage.buckets WHERE id = 'sa-strategy-setups';  -- alleen als leeg
