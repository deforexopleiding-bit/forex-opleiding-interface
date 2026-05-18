-- ============================================================
-- 2026-05-18 — Terugkom datetime kolom (Fase 6, commit 3a)
-- Voegt terugkom_datetime (timestamptz) toe naast de bestaande
-- terugkom_datum (date). Backfill vanuit bestaande date-waarden.
-- ============================================================

-- Stap 1: Voeg nieuwe kolom toe
ALTER TABLE follow_up_outcomes
  ADD COLUMN IF NOT EXISTS terugkom_datetime timestamptz;

-- Stap 2: Backfill vanuit terugkom_datum (middernacht Amsterdam-tijd)
UPDATE follow_up_outcomes
SET terugkom_datetime = (terugkom_datum::timestamp AT TIME ZONE 'Europe/Amsterdam')
WHERE terugkom_datum IS NOT NULL
  AND terugkom_datetime IS NULL;

-- Stap 3: Index voor queries op terugkom_datetime
CREATE INDEX IF NOT EXISTS idx_follow_up_outcomes_terugkom_datetime
  ON follow_up_outcomes(terugkom_datetime)
  WHERE terugkom_datetime IS NOT NULL;

-- Verificatie:
-- SELECT id, terugkom_datum, terugkom_datetime FROM follow_up_outcomes
-- WHERE terugkom_datum IS NOT NULL LIMIT 10;
