-- ============================================================================
-- BUGFIX STAP 2 — meta_param_mapping op event_vragenlijst_definitief
-- Datum: 2026-09-08
--
-- Probleem: de template is APPROVED maar meta_param_mapping = null. De events-
-- verzender (sendEventWhatsAppTemplate) resolvet dan 0 body-variabelen voor een
-- template met {{1}}..{{4}} → Meta weigert (132000) → geen WhatsApp.
--
-- Deze UPDATE zet alleen de mapping (status blijft APPROVED). De code heeft
-- daarnaast een fallback-mapping (paramMappingOverride) zodat WhatsApp óók zonder
-- deze UPDATE werkt; deze UPDATE zorgt dat het CRM-templatescherm de mapping
-- toont en dat de DB de canonieke bron blijft.
-- ============================================================================

UPDATE public.whatsapp_meta_templates
   SET meta_param_mapping = jsonb_build_object('body', jsonb_build_object(
         '1', 'attendee.voornaam',
         '2', 'event.titel',
         '3', 'event.datum',
         '4', 'attendee.vervolg_link'
       )),
       updated_at = now()
 WHERE name = 'event_vragenlijst_definitief';

-- Verificatie:
--   SELECT name, status, meta_param_mapping
--     FROM public.whatsapp_meta_templates WHERE name='event_vragenlijst_definitief';
