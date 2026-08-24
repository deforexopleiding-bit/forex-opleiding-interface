-- 2026-08-24 · Stale manual actions — drempel-key in app_settings.
--
-- Seed voor de configureerbare "hoeveel dagen open telt als stale"-drempel
-- die de wanbetalers-v2 Acties-tab widget gebruikt. Endpoint valt terug op
-- default 3 als de key ontbreekt; deze seed maakt de key expliciet zichtbaar
-- zodat een beheerder 'em zonder deploy kan aanpassen.
--
-- Shape van value: { "days": <number> }.
-- Later kan het naar {escalation:X, verify:Y, followup:Z, promise:W} groeien;
-- endpoint valt dan terug op de scalar-versie voor onbekende typen.

BEGIN;

INSERT INTO public.app_settings (key, value)
VALUES ('stale_manual_actions_threshold_days', '{"days": 3}'::jsonb)
ON CONFLICT (key) DO NOTHING;

DO $$
BEGIN
  RAISE NOTICE '── stale_manual_actions_threshold_days ─────────────────';
  RAISE NOTICE '  key seeded op { "days": 3 } (idempotent)';
END $$;

COMMIT;
