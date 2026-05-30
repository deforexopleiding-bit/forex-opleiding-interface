-- ============================================================================
-- Email Classifications — Fase 1 schema
-- Datum: 2026-05-30
-- Branch: feature/email-classifications-fase-1-schema
--
-- Doel: persistente cache van AI-classifier output (categorie + requires_action
-- + metadata) die nu alleen in browser-localStorage van email.html leeft.
--
-- Deze migratie maakt ALLEEN het schema. Geen runtime impact:
--  - tabel start leeg
--  - geen API-endpoint schrijft er nog naar (komt in Fase 2)
--  - geen consumer leest 'm (komt in Fase 3/4)
--
-- Volgende stappen:
--  - Fase 2: /api/email-agent + /api/reanalyze-all upserten naar deze tabel
--  - Fase 3: /api/emails JOIN met deze tabel + email_actions overrides
--  - Fase 4: dashboard via nieuwe /api/email-counts
--  - Fase 5: frontend cleanup (localStorage als instant-cache, niet bron)
--  - Fase 6: backfill via UI-knop in email.html
--
-- ── Verifie-queries na uitvoeren ────────────────────────────────────────────
-- SELECT count(*) FROM public.email_classifications;
-- SELECT * FROM pg_policies WHERE tablename = 'email_classifications';
-- SELECT indexname FROM pg_indexes WHERE tablename = 'email_classifications';
-- ============================================================================

BEGIN;

-- ── 1. TABEL ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.email_classifications (
  email_uid           text PRIMARY KEY,                       -- '<mailbox>:<imap_uid>' composite
  mailbox             text NOT NULL,                          -- 'leads@deforexopleiding.nl' etc
  category            text,                                   -- 'Nieuwe Lead' | 'Klantvragen' | …
  requires_action     boolean,                                -- AI-suggested
  confidence          smallint,                               -- 0-100
  source              text,                                   -- 'ai' | 'rule' | 'manual' | …
  priority            text,                                   -- 'urgent' | 'normaal' | 'laag'
  reasoning           text,                                   -- AI explanation
  key_signals         jsonb,                                  -- AI structured signals
  classified_at       timestamptz NOT NULL DEFAULT now(),
  classifier_version  text                                    -- bump bij prompt-wijziging
);

COMMENT ON TABLE public.email_classifications IS
  'Persistente AI-classifier output. Gevuld door /api/email-agent (Fase 2). Gedeelde knowledge — geen per-user rijen.';

-- ── 2. INDEXES ──────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_email_classifications_mailbox
  ON public.email_classifications (mailbox);

CREATE INDEX IF NOT EXISTS idx_email_classifications_at
  ON public.email_classifications (classified_at DESC);

-- Voor toekomstige reanalyze-flows: snel oude versies vinden.
CREATE INDEX IF NOT EXISTS idx_email_classifications_version
  ON public.email_classifications (classifier_version)
  WHERE classifier_version IS NOT NULL;

-- ── 3. RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE public.email_classifications ENABLE ROW LEVEL SECURITY;

-- SELECT: alle authenticated users (gedeelde knowledge, geen privacy-issue).
DROP POLICY IF EXISTS email_classifications_select ON public.email_classifications;
CREATE POLICY email_classifications_select ON public.email_classifications
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- INSERT/UPDATE/DELETE: alleen service_role (vanaf /api/email-agent met supabaseAdmin).
-- Reguliere user-clients (anon/authenticated) hebben hier NIETS te zoeken; classifier
-- is een backend-only verantwoordelijkheid.
DROP POLICY IF EXISTS email_classifications_insert ON public.email_classifications;
CREATE POLICY email_classifications_insert ON public.email_classifications
  FOR INSERT
  WITH CHECK (false);

DROP POLICY IF EXISTS email_classifications_update ON public.email_classifications;
CREATE POLICY email_classifications_update ON public.email_classifications
  FOR UPDATE
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS email_classifications_delete ON public.email_classifications;
CREATE POLICY email_classifications_delete ON public.email_classifications
  FOR DELETE
  USING (false);

-- NB: supabaseAdmin (service_role) bypasst RLS volledig en kan dus gewoon
-- insert/update doen. De policies hierboven blokkeren expliciet user-paden,
-- zelfs als per ongeluk een authenticated user de tabel zou aanroepen.

COMMIT;

-- ============================================================================
-- ROLLBACK (handmatig)
-- ============================================================================
-- BEGIN;
--   DROP POLICY IF EXISTS email_classifications_select ON public.email_classifications;
--   DROP POLICY IF EXISTS email_classifications_insert ON public.email_classifications;
--   DROP POLICY IF EXISTS email_classifications_update ON public.email_classifications;
--   DROP POLICY IF EXISTS email_classifications_delete ON public.email_classifications;
--   DROP INDEX IF EXISTS public.idx_email_classifications_version;
--   DROP INDEX IF EXISTS public.idx_email_classifications_at;
--   DROP INDEX IF EXISTS public.idx_email_classifications_mailbox;
--   DROP TABLE IF EXISTS public.email_classifications;
-- COMMIT;
