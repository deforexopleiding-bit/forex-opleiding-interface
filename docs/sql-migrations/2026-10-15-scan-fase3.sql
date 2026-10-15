-- ============================================================================
-- Strategie-scan — fase 3: handmatige klant-status op de scan
-- Datum: 2026-10-15
-- Branch: feat/scan-fase3
--
-- De klant-status in het overzicht komt uit twee bronnen (api/_lib/scan-klant.js):
--   1. automatisch uit de deals (gewonnen deal bij de lead / klant / e-mail);
--   2. handmatig door de assessor — deze kolommen. Handmatig heeft voorrang.
--
-- NIET BLOKKEREND voor het overzicht: api/scans-overzicht.js leest zonder deze
-- kolommen gewoon door (alles automatisch). Alleen het ZETTEN van een
-- handmatige status geeft dan een melding "draai eerst de migratie" (409).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; losse statements.
-- ============================================================================

ALTER TABLE public.scans ADD COLUMN IF NOT EXISTS klant_status_handmatig text NULL
  CHECK (klant_status_handmatig IN ('klant', 'in_gesprek', 'geen_klant'));
ALTER TABLE public.scans ADD COLUMN IF NOT EXISTS klant_status_door uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.scans ADD COLUMN IF NOT EXISTS klant_status_op timestamptz NULL;

-- ── CONTROLE ────────────────────────────────────────────────────────────────
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'scans' AND column_name LIKE 'klant_status%';
-- (verwacht: 3 rijen)

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- ALTER TABLE public.scans DROP COLUMN IF EXISTS klant_status_handmatig,
--   DROP COLUMN IF EXISTS klant_status_door, DROP COLUMN IF EXISTS klant_status_op;
