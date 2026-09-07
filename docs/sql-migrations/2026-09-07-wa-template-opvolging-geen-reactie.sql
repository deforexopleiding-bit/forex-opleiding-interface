-- 2026-09-07 · whatsapp_meta_templates seed: opvolging_geen_reactie
--
-- CONTEXT
-- Neutrale opvolg-template voor reminder 1 van de no-reply-cyclus
-- (joost_config.autonomy_config.no_reply, module finance). Geen bedrag, geen
-- factuurnummer, geen vervaldatum, geen ondertekening. De bijzin over de
-- openstaande factuur staat er bewust in om de UTILITY-grond te behouden.
-- Zie docs/whatsapp-template-opvolging-geen-reactie.md.
--
-- WAT DIT SCRIPT DOET
-- Het zet de template LOKAAL klaar op status 'LOCAL' — exact wat de knop
-- "Opslaan" in Instellingen → WhatsApp doet. Er wordt NIETS naar Meta gestuurd.
-- Indienen gebeurt daarna met de hand: Instellingen → WhatsApp → Submit op de
-- regel van deze template. Dat is bewust een menselijke handeling.
--
-- ALTERNATIEF: dezelfde rij kun je aanmaken via de UI (Nieuwe WhatsApp-template
-- → velden invullen → Opslaan). Doe één van beide, niet allebei — de ON
-- CONFLICT hieronder maakt een dubbele run wel veilig.
--
-- NA GOEDKEURING
--   1. Controleer `category`, niet alleen `status`. Een als UTILITY ingediende
--      template die WhatsApp als MARKETING beoordeelt wordt sinds 9 april 2025
--      goedgekeurd ALS MARKETING — je ziet dan gewoon 'APPROVED' staan.
--   2. Pas dán `joost_config.autonomy_config.no_reply.reminder_1_template_name`
--      vullen met 'opvolging_geen_reactie' (Instellingen → Joost AI → Autonomy).
--      Eerder invullen laat de send terugvallen op het legacy 5-parameter-pad
--      en dan weigert Meta hem.
--
-- Idempotent: ON CONFLICT DO UPDATE. Re-run veilig.
-- 0 klant-writes; puur config in whatsapp_meta_templates.

BEGIN;

INSERT INTO public.whatsapp_meta_templates (
  business_account_id,
  name,
  language,
  category,
  header_type,
  body_text,
  body_examples,
  meta_param_mapping,
  status
)
VALUES (
  '990429800401598',                              -- Meta WABA-id (bestaand, uit foundation-migratie)
  'opvolging_geen_reactie',
  'nl',
  'UTILITY',
  'NONE',
  'Hey {{klant.voornaam}}, ik heb nog geen reactie van je ontvangen op mijn bericht over je openstaande factuur. Laat je even weten hoe we dit kunnen afronden? Alvast bedankt.',
  jsonb_build_object('body_text', jsonb_build_array(jsonb_build_array('Jeffrey'))),
  jsonb_build_object('body', jsonb_build_object('1', 'klant.voornaam')),
  'LOCAL'                                          -- NIET ingediend; submit is een handmatige klik
)
ON CONFLICT (business_account_id, name, language) DO UPDATE
  SET body_text          = EXCLUDED.body_text,
      body_examples      = EXCLUDED.body_examples,
      meta_param_mapping = EXCLUDED.meta_param_mapping,
      category           = EXCLUDED.category,
      header_type        = EXCLUDED.header_type,
      updated_at         = now()
  -- Een al ingediende of goedgekeurde rij niet terugzetten naar LOCAL.
  WHERE public.whatsapp_meta_templates.status = 'LOCAL';

DO $$
BEGIN
  RAISE NOTICE '-- opvolging_geen_reactie geseed --------------------';
  RAISE NOTICE '  status = LOCAL (submit naar Meta nog te doen, met de hand)';
  RAISE NOTICE '  named placeholder {{klant.voornaam}} -> mapping body.1';
  RAISE NOTICE '  na APPROVED: eerst category checken, dan pas';
  RAISE NOTICE '  no_reply.reminder_1_template_name invullen';
END $$;

COMMIT;

-- Verificatie:
--   SELECT name, language, status, category, body_text, meta_param_mapping
--   FROM public.whatsapp_meta_templates
--   WHERE name = 'opvolging_geen_reactie';
