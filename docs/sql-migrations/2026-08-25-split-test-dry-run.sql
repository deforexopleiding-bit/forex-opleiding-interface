-- 2026-08-25 · Splits test-dry-run los van productie-dry-run.
--
-- Doel: de test-cockpit / harness kan de productie-verzending niet meer
-- togglen of muten. Twee aparte vlaggen in app_settings:
--   • dunning_dry_run       — productie. Geschreven door productie-code.
--   • dunning_test_dry_run  — test/sandbox. Geschreven door
--                             wanbetalers-sandbox-set-dry-run → setDryRun()
--                             (en niks anders).
--
-- Beide keys defaulten fail-safe TRUE (send OFF) in _lib/dunning-dry-run.js
-- als een key ontbreekt of onbekend is. Deze migratie seed't alleen de
-- nieuwe key expliciet zodat het beheer transparant is.
--
-- Idempotent: ON CONFLICT DO NOTHING → herhaald draaien is veilig, laat de
-- bestaande waarde ongewijzigd als de key al bestaat.

INSERT INTO app_settings (key, value)
VALUES ('dunning_test_dry_run', '{"enabled": true}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Verifieer beide vlaggen na de insert.
DO $$
DECLARE
  v_prod jsonb;
  v_test jsonb;
BEGIN
  SELECT value INTO v_prod FROM app_settings WHERE key = 'dunning_dry_run';
  SELECT value INTO v_test FROM app_settings WHERE key = 'dunning_test_dry_run';
  RAISE NOTICE '── dry-run vlaggen na migratie ─────────────────────────────';
  RAISE NOTICE '  dunning_dry_run       (productie): %', COALESCE(v_prod::text, '(ontbreekt → fail-safe AAN)');
  RAISE NOTICE '  dunning_test_dry_run  (test):      %', COALESCE(v_test::text, '(ontbreekt → fail-safe AAN)');
END $$;
