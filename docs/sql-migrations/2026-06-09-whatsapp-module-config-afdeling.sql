-- 2026-06-09 — whatsapp_module_config: afdelings-contactgegevens
--
-- Voegt 4 nullable kolommen toe aan whatsapp_module_config voor
-- per-module (per-afdeling) contactgegevens die als template-variabelen
-- ({{afdeling.telefoon}}, {{afdeling.whatsapp}}, {{afdeling.email}},
-- {{afdeling.ondertekenaar}}) ingevuld worden bij send-time.
--
-- Seed-update vult de bestaande 'finance' rij met Forex-administratie
-- gegevens.
--
-- Backward-compat: alle kolommen nullable, geen default. Legacy rows zonder
-- waarden resolven naar lege string in template-render pipeline.

BEGIN;

ALTER TABLE whatsapp_module_config
  ADD COLUMN IF NOT EXISTS afdeling_telefoon text,
  ADD COLUMN IF NOT EXISTS afdeling_whatsapp text,
  ADD COLUMN IF NOT EXISTS afdeling_email text,
  ADD COLUMN IF NOT EXISTS afdeling_ondertekenaar text;

UPDATE whatsapp_module_config
SET afdeling_telefoon = '+31 85 130 83 62',
    afdeling_whatsapp = '+31 6 51031673',
    afdeling_email = 'administratie@deforexopleiding.nl',
    afdeling_ondertekenaar = 'De Forex Opleiding'
WHERE module = 'finance';

COMMIT;
