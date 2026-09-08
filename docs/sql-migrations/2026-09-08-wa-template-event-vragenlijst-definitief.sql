-- ============================================================================
-- STAP 2 — WhatsApp-template seed: event_vragenlijst_definitief
-- Datum: 2026-09-08
--
-- Nieuw UTILITY-template dat de toegelaten gate-aanmelder naar de branded
-- dfo-website vervolgpagina stuurt om z'n inschrijving definitief te maken.
-- Aangemaakt met status LOCAL zodat 'ie in het CRM-templatescherm verschijnt en
-- via "Indienen bij Meta" (admin-meta-templates-submit) kan worden ingediend.
-- Mail werkt los van de Meta-approval; WhatsApp verzendt pas na APPROVED.
--
-- Variabelen (positioneel, body):
--   {{1}} attendee.voornaam
--   {{2}} event.titel
--   {{3}} event.datum
--   {{4}} attendee.vervolg_link   (dfo-website /vervolg?t=<choice_token>)
-- De link staat BEWUST in de body ({{4}}) i.p.v. in een URL-knop: de
-- events-verzender (sendEventWhatsAppTemplate) vult alleen body-variabelen via
-- meta_param_mapping.body — knop-parameters worden daar niet gevuld.
-- Body eindigt niet op een variabele; geen emoji in knoppen (er is geen knop).
--
-- WABA: 990429800401598 (productie). VERIFIEER dat dit dezelfde WABA is als de
--   events-module gebruikt:
--     SELECT business_account_id FROM public.whatsapp_module_config
--      WHERE module='events' AND is_active=true;
--   Wijkt die af? Pas dan business_account_id hieronder aan (templates leven
--   per WABA).
--
-- Idempotent: ON CONFLICT (business_account_id, name, language) DO UPDATE.
-- ============================================================================

BEGIN;

INSERT INTO public.whatsapp_meta_templates
  (business_account_id, name, language, category, header_type, body_text, body_examples, buttons, meta_param_mapping, status)
VALUES
('990429800401598', 'event_vragenlijst_definitief', 'nl', 'UTILITY', 'NONE',
'Hoi {{1}}, je bent toegelaten voor {{2}} op {{3}}.

Je plek is nog niet definitief. Vul kort onze vragenlijst in (2 minuten) via deze link: {{4}}

Vul je gegevens niet in, dan vervalt je plek automatisch.',
 jsonb_build_object(
   '1', 'Jeffrey',
   '2', 'Forex Masterclass',
   '3', 'zaterdag 20 september om 10:30',
   '4', 'https://www.deforexopleiding.nl/vervolg?t=00000000-0000-0000-0000-000000000000'
 ),
 NULL,
 jsonb_build_object('body', jsonb_build_object(
   '1', 'attendee.voornaam',
   '2', 'event.titel',
   '3', 'event.datum',
   '4', 'attendee.vervolg_link'
 )),
 'LOCAL')
ON CONFLICT (business_account_id, name, language) DO UPDATE SET
  category          = EXCLUDED.category,
  header_type       = EXCLUDED.header_type,
  body_text         = EXCLUDED.body_text,
  body_examples     = EXCLUDED.body_examples,
  buttons           = EXCLUDED.buttons,
  meta_param_mapping= EXCLUDED.meta_param_mapping,
  status            = 'LOCAL',
  updated_at        = now();

COMMIT;

-- Verificatie:
--   SELECT name, language, status, body_text, meta_param_mapping
--     FROM public.whatsapp_meta_templates WHERE name='event_vragenlijst_definitief';
