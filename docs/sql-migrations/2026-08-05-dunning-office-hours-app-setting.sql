-- 2026-08-05 — dunning_office_hours: send-venster configureerbaar
--
-- Aanleiding: cron-dunning-engine wordt uurlijks (0 * * * *) zodat wachtstappen
-- die overdag aflopen binnen 60 min worden opgepakt. Om te voorkomen dat er
-- 's nachts aanmaningen uitgaan, blokkeert de engine SEND-stappen (email /
-- whatsapp) buiten dit venster. Wait/task/stop/resume mogen doorlopen zodat
-- de workflow-pointer niet stilstaat.
--
-- Configuratie via app_settings.dunning_office_hours (jsonb):
--   {
--     "tz":    "Europe/Amsterdam",
--     "start": "08:00",
--     "end":   "20:00",
--     "days":  [0, 1, 2, 3, 4, 5, 6]  -- 0=zo, 6=za
--   }
--
-- Default uit user-keuze (2026-08-05): 08:00-20:00 elke dag inclusief zaterdag
-- en zondag. DST-aware (CET/CEST-wisseling automatisch via Intl.DateTimeFormat
-- in api/_lib/dunning-office-hours.js).
--
-- ADDITIEF: alleen een INSERT ... ON CONFLICT DO NOTHING. Bestaande overrides
-- worden NIET overschreven. Bij ontbreken van de rij valt code terug op
-- dezelfde default (DEFAULT_OFFICE_HOURS in de helper), dus deze migratie is
-- geen harde vereiste voor de code-deploy — de default werkt sowieso.
-- Nut: user kan via de bestaande app_settings-UI/-endpoint het venster
-- aanpassen zonder deploy.

INSERT INTO public.app_settings (key, value)
VALUES (
  'dunning_office_hours',
  jsonb_build_object(
    'tz',    'Europe/Amsterdam',
    'start', '08:00',
    'end',   '20:00',
    'days',  jsonb_build_array(0, 1, 2, 3, 4, 5, 6)
  )
)
ON CONFLICT (key) DO NOTHING;
