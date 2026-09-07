-- 2026-09-07 — de TITEL van de sessie die de onboarding afsloot
-- DRAAIEN OP: forex-command-center (nsjnsvlmdhunzqkdvagm)
--
-- WAAROM. De afsluitregel kijkt naar status 'afgerond' en niet naar het soort
-- sessie. Een testsessie die per ongeluk op afgerond wordt gezet sluit dus een
-- echte onboarding. Gemeten op 7 september: twee sessies in het LMS met "test"
-- of "verificatie" in de titel, waarvan één afgerond. Klein, niet nul, en het
-- groeit vanzelf zodra iemand iets uitprobeert.
--
-- Er komt BEWUST GEEN filter op woorden in die titel — raden op een titel is
-- precies het soort regel dat later stil de verkeerde kant op valt. Wat er wel
-- komt: wie een dossier opent ziet welke sessie het sloot, niet alleen wanneer.
-- Het is nadrukkelijk GEEN alarm; er gaat geen bericht uit bij een
-- automatische afsluiting.
--
-- ⚠ BLOKKEREND. api/cron/onboarding-eerste-sessie-afronden.js noemt deze kolom
-- bij naam in zijn UPDATE. Draait deze migratie niet, dan faalt elke
-- afsluitpoging met een column-error en sluit de cron NIETS meer af. Draai 'm
-- vóór of direct na de merge.

BEGIN;

ALTER TABLE public.onboardings
  ADD COLUMN IF NOT EXISTS auto_afgerond_sessie_titel text;

COMMENT ON COLUMN public.onboardings.auto_afgerond_sessie_titel IS
  'Titel van de hlms_sessie (dfo-lms) die deze onboarding afsloot, zoals die luidde op het moment van afsluiten. Mag leeg zijn: rijen van vóór deze kolom hebben ''m niet, en een onbereikbaar LMS levert ''m niet. Of de titels gelezen zijn staat in de cron-uitkomst (titels_gelezen), niet in deze kolom.';

COMMIT;

-- Controle:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'onboardings' AND column_name = 'auto_afgerond_sessie_titel';
--
-- Rollback:
--   ALTER TABLE public.onboardings DROP COLUMN IF EXISTS auto_afgerond_sessie_titel;
