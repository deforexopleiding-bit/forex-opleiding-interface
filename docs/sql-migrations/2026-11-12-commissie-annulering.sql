-- =============================================================================
-- 2026-11-12 — Commissie volgt annulatie (mentorcommissie)
--
-- WAAROM
--   Een sale die de klant annuleert (offerte verwijderd / laatste abonnement
--   weg) of die vervangen wordt door een nieuwe offerte, zet de mentor-
--   commissie op "geannuleerd" — met reden, datum en wie het deed. Tot nu toe
--   stond dat enkel als vrije tekst in `note`. Deze kolommen maken het
--   leesbaar en maken "herstellen" exact (terug naar de vorige status).
--
-- ADDITIEF — vier nullable kolommen + één CHECK die enkel nieuwe waarden
-- beperkt. Raakt geen bestaande rij.
--
-- NIET BLOKKEREND: de code schrijft deze kolommen faalzacht (zonder migratie
-- probeert ze opnieuw zonder de kolommen). De reden staat ALTIJD ook in
-- `note` in het bestaande formaat "| Geannuleerd (<reden>) op JJJJ-MM-DD",
-- dus zonder migratie werkt alles; enkel "door wie" en de exacte vorige
-- status voor herstellen ontbreken dan (herstellen valt terug op "pending").
--
-- Supabase SQL-editor: elk statement draait los; geen DO-block, geen temp-tabel.
-- =============================================================================

ALTER TABLE public.mentor_ledger_entries
  ADD COLUMN IF NOT EXISTS geannuleerd_op timestamptz;

ALTER TABLE public.mentor_ledger_entries
  ADD COLUMN IF NOT EXISTS geannuleerd_door uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.mentor_ledger_entries
  ADD COLUMN IF NOT EXISTS geannuleerd_reden text;

ALTER TABLE public.mentor_ledger_entries
  ADD COLUMN IF NOT EXISTS geannuleerd_soort text;

ALTER TABLE public.mentor_ledger_entries
  ADD COLUMN IF NOT EXISTS status_voor_annulering text;

ALTER TABLE public.mentor_ledger_entries
  DROP CONSTRAINT IF EXISTS mentor_ledger_entries_geannuleerd_soort_check;

ALTER TABLE public.mentor_ledger_entries
  ADD CONSTRAINT mentor_ledger_entries_geannuleerd_soort_check
  CHECK (geannuleerd_soort IS NULL OR geannuleerd_soort IN ('klant_annuleert', 'vervangen', 'handmatig'));

CREATE INDEX IF NOT EXISTS idx_ledger_source_quote
  ON public.mentor_ledger_entries (source_quote_id)
  WHERE parent_entry_id IS NULL;

-- Controle na het draaien (verwacht 5 rijen):
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'mentor_ledger_entries'
--    AND column_name IN ('geannuleerd_op','geannuleerd_door','geannuleerd_reden','geannuleerd_soort','status_voor_annulering');
