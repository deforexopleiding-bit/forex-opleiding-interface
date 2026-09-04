-- 2026-09-04 · whatsapp_meta_templates seed: annulering + verzet (2 templates)
--
-- CONTEXT
-- Twee nieuwe WhatsApp-templates voor de afspraak-flow: een bevestiging bij
-- ANNULEREN en bij VERZETTEN van een kennismakingsgesprek. Status LOCAL zodat
-- ze meteen in het CRM-templatescherm staan; indienen bij Meta gebeurt daarna
-- per template via "Indienen bij Meta".
--
-- Zelfde patroon als 2026-09-04-wa-templates-afspraak-flow.sql:
--   WABA 990429800401598 · UTILITY · nl · positionele {{N}} · body_examples in
--   object-vorm {"1":…} · geen buttons · meta_param_mapping NULL.
--
-- Idempotent: ON CONFLICT (business_account_id, name, language) DO UPDATE.
-- 0 incasso-writes; puur config in whatsapp_meta_templates.

BEGIN;

INSERT INTO public.whatsapp_meta_templates
  (business_account_id, name, language, category, header_type, body_text, body_examples, buttons, status)
VALUES
-- 1) afspraak_annulering_v1 — bevestiging na annulering (3 vars, geen knop)
('990429800401598', 'afspraak_annulering_v1', 'nl', 'UTILITY', 'NONE',
'Hoi {{1}}, je kennismakingsgesprek met De Forex Opleiding van {{2}} is geannuleerd.

Wil je alsnog kennismaken? Je kunt hier een nieuw moment plannen: {{3}}

Tot snel!',
 jsonb_build_object(
   '1', 'Paco',
   '2', 'dinsdag 9 september om 11:30',
   '3', 'https://deforexopleiding.nl/agenda/kantoor'
 ),
 NULL,
 'LOCAL'),

-- 2) afspraak_verzet_v1 — bevestiging na verzetten (3 vars, geen knop)
('990429800401598', 'afspraak_verzet_v1', 'nl', 'UTILITY', 'NONE',
'Hoi {{1}}, gelukt — je kennismakingsgesprek met De Forex Opleiding is verzet.

📅 Nieuw moment: {{2}}
💻 Via Zoom: {{3}}

Je krijgt vóór de afspraak nog een herinnering. Tot dan!',
 jsonb_build_object(
   '1', 'Paco',
   '2', 'woensdag 10 september om 14:00',
   '3', 'https://zoom.us/j/12345678'
 ),
 NULL,
 'LOCAL')

ON CONFLICT (business_account_id, name, language) DO UPDATE
  SET body_text     = EXCLUDED.body_text,
      body_examples = EXCLUDED.body_examples,
      buttons       = EXCLUDED.buttons,
      category      = EXCLUDED.category,
      header_type   = EXCLUDED.header_type,
      updated_at    = now();

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
    FROM public.whatsapp_meta_templates
   WHERE business_account_id = '990429800401598'
     AND name IN ('afspraak_annulering_v1', 'afspraak_verzet_v1');
  RAISE NOTICE '── annulering/verzet templates geseed ─────────────';
  RAISE NOTICE '  aanwezig: % / 2 (status LOCAL)', n;
  RAISE NOTICE '  volgende stap: per template "Indienen bij Meta" in de CRM-UI';
END $$;

COMMIT;

-- ============================================================================
-- VERIFICATIE (draai NA COMMIT)
-- ============================================================================
--   SELECT name, language, status, jsonb_object_keys(body_examples) AS var
--     FROM public.whatsapp_meta_templates
--    WHERE business_account_id = '990429800401598'
--      AND name IN ('afspraak_annulering_v1','afspraak_verzet_v1')
--    ORDER BY name;
--   Verwacht: 2 templates, status LOCAL.
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
--   DELETE FROM public.whatsapp_meta_templates
--    WHERE business_account_id='990429800401598'
--      AND name IN ('afspraak_annulering_v1','afspraak_verzet_v1');
-- ============================================================================
