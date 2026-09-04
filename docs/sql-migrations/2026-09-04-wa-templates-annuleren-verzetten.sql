-- 2026-09-04 · whatsapp_meta_templates seed: annuleren + verzetten (2 templates)
--
-- CONTEXT
-- Twee nieuwe WhatsApp-templates voor de afspraak-flow: bevestiging van een
-- annulering (met nieuwe boek-link) en bevestiging van een verzetting (met
-- nieuwe tijd + Zoom-link). Zelfde patroon als 2026-09-04-wa-templates-
-- afspraak-flow.sql: status LOCAL zodat ze direct zichtbaar zijn in het CRM-
-- templatescherm; INDIENEN bij Meta gebeurt daarna per template via de knop
-- "Indienen bij Meta" (endpoint admin-meta-templates-submit).
--
-- WABA:      990429800401598 (productie-WABA, zelfde lijn als de andere
--            afspraak-/toegang-templates).
-- Categorie: UTILITY.
-- Taal:      nl.
-- Variabelen: positioneel {{1}}..{{N}}. body_examples in object-vorm
--            {"1":"…","2":"…"} zodat admin-meta-templates-submit het aantal
--            voorbeelden 1-op-1 aan de {{N}}-variabelen kan koppelen (anders
--            weigert Meta met #132000). meta_param_mapping blijft NULL — dat
--            is alleen nodig voor named-placeholder-resolutie bij het
--            VERSTUREN (latere fase; deze migratie bouwt geen verzendlogica).
-- Knoppen:   geen (buttons = NULL). Beide templates staan puur informatief.
--
-- NOT NULL-guards: business_account_id, name, category, body_text expliciet
-- gezet. language/status/created_at/updated_at via default of expliciet.
-- created_by_user_id blijft NULL (FK ON DELETE SET NULL) — seed heeft geen
-- interactieve gebruiker, identiek aan de andere seed-migraties.
--
-- Idempotent: ON CONFLICT (business_account_id, name, language) DO UPDATE
-- overschrijft body/examples/buttons/status — herrun is veilig.
-- 0 incasso-writes; puur config in whatsapp_meta_templates.

BEGIN;

INSERT INTO public.whatsapp_meta_templates
  (business_account_id, name, language, category, header_type, body_text, body_examples, buttons, status)
VALUES
-- 1) afspraak_annulering_v1 — bevestiging van een geannuleerde afspraak (3 vars, geen knop)
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

-- 2) afspraak_verzet_v1 — bevestiging van een verzette afspraak (3 vars, geen knop)
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
SET category      = EXCLUDED.category,
    header_type   = EXCLUDED.header_type,
    body_text     = EXCLUDED.body_text,
    body_examples = EXCLUDED.body_examples,
    buttons       = EXCLUDED.buttons,
    status        = EXCLUDED.status,
    updated_at    = now();

COMMIT;
