-- 2026-09-04 · whatsapp_meta_templates seed: afspraak-flow (5 templates)
--
-- CONTEXT
-- Vijf nieuwe WhatsApp-templates voor de afspraak-/call-flow (bevestiging +
-- reminders + join-link). Ze worden aangemaakt met status LOCAL zodat ze
-- direct zichtbaar zijn in het CRM-templatescherm (Instellingen →
-- WhatsApp-templatebeheer, of Leadsonderhoud → Templates → WhatsApp templates).
-- Het INDIENEN bij Meta gebeurt daarna per template via de knop
-- "Indienen bij Meta" (endpoint admin-meta-templates-submit) — dat vereist de
-- live Meta-token en kan niet vanuit deze migratie.
--
-- WABA:      990429800401598 (de bestaande productie-WABA, zelfde lijn als de
--            toegang-flow — bevestig_toegang_*, reminder_toegang_*,
--            toegang_verlengd_nl). Templates leven per WABA, niet per nummer;
--            welk nummer straks verstuurt (welkom/Esmee) is een verzendfase-
--            keuze, geen template-keuze.
-- Categorie: UTILITY (afspraakbevestiging/-reminder).
-- Taal:      nl.
-- Variabelen: positioneel {{1}}..{{N}}. body_examples staat in de object-vorm
--            {"1":"…","2":"…"} zodat admin-meta-templates-submit het aantal
--            voorbeelden 1-op-1 aan de {{N}}-variabelen kan koppelen (anders
--            weigert Meta met #132000). meta_param_mapping blijft NULL — dat is
--            alleen nodig voor named-placeholder-resolutie bij het VERSTUREN
--            (latere fase; deze migratie bouwt geen verzendlogica).
-- Knoppen:   afspraak_reminder_2u_v1 en afspraak_reminder_30m_v1 krijgen één
--            QUICK_REPLY-knop "Ik ben erbij ✅".
--
-- NOT NULL-check (kolommen zonder default die de INSERT moet vullen):
--   business_account_id, name, category, body_text → allemaal expliciet gezet.
--   language/status hebben een default maar zetten we expliciet.
--   id/created_at/updated_at → defaults. header_type/header_content/
--   body_examples/footer_text/buttons/meta_param_mapping/folder_id/
--   meta_template_id/rejection_reason/*_at → nullable of default.
--   created_by_user_id is NULLABLE (FK ON DELETE SET NULL) → bewust NIET gezet:
--   dit is een seed zonder interactieve gebruiker (identiek aan de
--   toegang_verlengd_nl-seed). Geen NOT NULL-kolom blijft dus leeg.
--
-- Idempotent: ON CONFLICT (business_account_id, name, language) DO UPDATE.
--             Re-run overschrijft body/examples/buttons en is veilig.
-- 0 incasso-writes; puur config in whatsapp_meta_templates.

BEGIN;

INSERT INTO public.whatsapp_meta_templates
  (business_account_id, name, language, category, header_type, body_text, body_examples, buttons, status)
VALUES
-- 1) afspraak_bevestiging_v1 — bevestiging na boeking (4 vars, geen knop)
('990429800401598', 'afspraak_bevestiging_v1', 'nl', 'UTILITY', 'NONE',
'Hoi {{1}}, gelukt! ✅ Je kennismakingsgesprek met De Forex Opleiding staat gepland.

Waar het over gaat: in ongeveer 20 minuten kijken we samen naar jouw situatie en je doelen, en maken we een persoonlijk plan. Geen verplichtingen — we leren je gewoon even goed kennen.

📅 Wanneer: {{2}}
💻 Waar: via Zoom → {{3}}

Handig om te doen: zoek een rustige plek met een goede verbinding en pak er eventueel pen en papier bij.

Kan het onverhoopt niet doorgaan? Verzetten of annuleren kan hier: {{4}}

We kijken ernaar uit je te spreken. Tot dan! 🚀',
 jsonb_build_object(
   '1', 'Paco',
   '2', 'dinsdag 9 september om 11:30',
   '3', 'https://zoom.us/j/12345678',
   '4', 'https://deforexopleiding.nl/afspraak/wijzigen/abc123'
 ),
 NULL,
 'LOCAL'),

-- 2) afspraak_reminder_24u_v1 — reminder 24u vooraf (4 vars, geen knop)
('990429800401598', 'afspraak_reminder_24u_v1', 'nl', 'UTILITY', 'NONE',
'Hoi {{1}}, nog even een vriendelijke herinnering: morgen staat je kennismakingsgesprek met De Forex Opleiding gepland. 🙌

📅 Wanneer: {{2}}
💻 Waar: via Zoom → {{3}}

We kijken ernaar uit om met je te sparren over je doelen en samen een plan te maken dat bij je past. Zorg dat je er een paar minuten van tevoren klaar voor zit.

Komt het net niet uit? Je kunt je afspraak nog verzetten naar een ander moment: {{4}}',
 jsonb_build_object(
   '1', 'Paco',
   '2', 'dinsdag 9 september om 11:30',
   '3', 'https://zoom.us/j/12345678',
   '4', 'https://deforexopleiding.nl/afspraak/wijzigen/abc123'
 ),
 NULL,
 'LOCAL'),

-- 3) afspraak_reminder_2u_v1 — reminder 2u vooraf (2 vars, QUICK_REPLY-knop)
('990429800401598', 'afspraak_reminder_2u_v1', 'nl', 'UTILITY', 'NONE',
'Hoi {{1}}, over 2 uur is het zover — om {{2}} start je kennismakingsgesprek met De Forex Opleiding. 🎯

We hebben speciaal tijd voor jou vrijgemaakt, dus we horen graag even of je erbij bent.

Kun je bevestigen dat het je lukt? Tik hieronder om te bevestigen. 👇',
 jsonb_build_object(
   '1', 'Paco',
   '2', '11:30'
 ),
 jsonb_build_array(jsonb_build_object('type', 'QUICK_REPLY', 'text', 'Ik ben erbij ✅')),
 'LOCAL'),

-- 4) afspraak_reminder_30m_v1 — reminder 30m vooraf (3 vars, QUICK_REPLY-knop)
('990429800401598', 'afspraak_reminder_30m_v1', 'nl', 'UTILITY', 'NONE',
'Hoi {{1}}, over 30 minuten ({{2}}) begint je kennismakingsgesprek en we houden je plek graag vrij.

Laat je ons even weten of het je lukt? Zo weten we zeker dat we op je kunnen rekenen. 🙌

💻 Zoom-link: {{3}}',
 jsonb_build_object(
   '1', 'Paco',
   '2', '11:30',
   '3', 'https://zoom.us/j/12345678'
 ),
 jsonb_build_array(jsonb_build_object('type', 'QUICK_REPLY', 'text', 'Ik ben erbij ✅')),
 'LOCAL'),

-- 5) afspraak_zoom_5min_v1 — join-link ~5 min vooraf (2 vars, geen knop)
('990429800401598', 'afspraak_zoom_5min_v1', 'nl', 'UTILITY', 'NONE',
'Hoi {{1}}, we beginnen zo! ⏱️ Over ongeveer 5 minuten start je kennismakingsgesprek.

Klik hier om direct te joinen:
{{2}}

Lukt het inloggen niet meteen? Geen stress — stuur ons even een berichtje, dan helpen we je er zo doorheen. Tot zo! 👋',
 jsonb_build_object(
   '1', 'Paco',
   '2', 'https://zoom.us/j/12345678'
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
     AND name IN (
       'afspraak_bevestiging_v1',
       'afspraak_reminder_24u_v1',
       'afspraak_reminder_2u_v1',
       'afspraak_reminder_30m_v1',
       'afspraak_zoom_5min_v1'
     );
  RAISE NOTICE '── afspraak-flow templates geseed ─────────────────';
  RAISE NOTICE '  aanwezig: % / 5 (status LOCAL)', n;
  RAISE NOTICE '  volgende stap: per template "Indienen bij Meta" in de CRM-UI';
END $$;

COMMIT;

-- ============================================================================
-- VERIFICATIE (draai NA COMMIT)
-- ============================================================================
--   SELECT name, language, status, jsonb_object_keys(body_examples) AS var
--     FROM public.whatsapp_meta_templates
--    WHERE business_account_id = '990429800401598'
--      AND name LIKE 'afspraak\_%'
--    ORDER BY name;
--   Verwacht: 5 templates, status LOCAL.
--
-- Post-Meta-approval (na "Indienen bij Meta" + goedkeuring; UI "Sync" doet dit
-- automatisch, handmatig kan ook):
--   UPDATE public.whatsapp_meta_templates
--      SET status='APPROVED', approved_at=now(), meta_template_id='<Meta-id>'
--    WHERE business_account_id='990429800401598' AND name='<template>' AND language='nl';
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
--   DELETE FROM public.whatsapp_meta_templates
--    WHERE business_account_id='990429800401598'
--      AND name IN ('afspraak_bevestiging_v1','afspraak_reminder_24u_v1',
--                   'afspraak_reminder_2u_v1','afspraak_reminder_30m_v1',
--                   'afspraak_zoom_5min_v1');
-- ============================================================================
