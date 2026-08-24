-- 2026-08-24 · profiles.deleted_at kolom voor SOFT-DELETE van gebruikers.
--
-- CONTEXT
-- Instellingen → Gebruikers v2 krijgt beheer (open/edit/inactief/verwijderen).
-- "Verwijderen" is een SOFT-delete: rij blijft bestaan (audit + FK-safety),
-- maar wordt uit de lijst gefilterd. Backend zet ook auth-ban + verwijdert
-- user_roles zodat de account niet meer kan inloggen.
--
-- Idempotent: IF NOT EXISTS guards. Herhaald draaien is veilig.
-- 0 data-mutatie; alleen schema-uitbreiding.

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;

-- Partial index voor de GET-filter (WHERE deleted_at IS NULL is de default query).
CREATE INDEX IF NOT EXISTS profiles_active_users_idx
  ON public.profiles (email)
  WHERE deleted_at IS NULL;

DO $$
BEGIN
  RAISE NOTICE '── profiles.deleted_at ────────────────────────────';
  RAISE NOTICE '  kolom aangemaakt (of al aanwezig)';
  RAISE NOTICE '  partial index profiles_active_users_idx OK';
END $$;

COMMIT;
