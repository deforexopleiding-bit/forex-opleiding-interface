-- =============================================================================
-- Joost AI — E1.0 seed completion
-- Datum: 2026-06-09
-- Branch: feat/joost-e10-foundation
--
-- Doel:
--   De originele E1.0-foundation-migratie (2026-06-09-joost-e10-foundation.sql)
--   gebruikt INSERT ... ON CONFLICT (module) DO NOTHING. Daardoor wordt een rij
--   die in een partial/eerder draaide staat staat (bv. lege persona_tone of
--   lege system_prompt_template) niet meer bijgewerkt naar de spec-defaults.
--
--   Deze migratie zorgt dat de finance-rij de spec-conforme defaults heeft
--   (persona_tone, system_prompt_template, knowledge_base, model, is_enabled),
--   zonder bestaande user-input te overschrijven. Patroon: COALESCE(NULLIF(...))
--   per kolom — alleen lege/NULL waardes worden bijgewerkt naar de seed,
--   echte input van de admin blijft staan.
--
--   knowledge_base is jsonb en kent geen NULLIF op '{}'::jsonb; we vergelijken
--   expliciet op een leeg object. model en is_enabled vergelijken we op NULL
--   resp. forceren we naar true (E1.0 wil de assistent default aan).
--
-- Idempotent: BEGIN/COMMIT + ON CONFLICT + COALESCE+NULLIF. Veilig om opnieuw
-- te draaien — tweede run is no-op zodra de rij compleet is.
--
-- -- Verifie-queries na uitvoeren ---------------------------------------------
-- SELECT module, persona_name, persona_tone, model, temperature,
--        context_message_count, is_enabled,
--        length(system_prompt_template) AS prompt_len,
--        jsonb_typeof(knowledge_base)  AS kb_type
--   FROM joost_config
--  WHERE module = 'finance';
-- -- Verwacht: prompt_len > 200, kb_type = 'object', is_enabled = true,
-- --           temperature = 0.30, context_message_count = 20.
-- =============================================================================

BEGIN;

INSERT INTO public.joost_config
  (module, persona_name, persona_tone, system_prompt_template, knowledge_base,
   model, temperature, context_message_count, is_enabled)
VALUES (
  'finance',
  'Joost',
  'professioneel, vriendelijk, oplossingsgericht - Nederlands',
  'Je bent Joost, een vriendelijke en oplossingsgerichte incasso-medewerker van {{company_name}}.

Je doel: klanten helpen met openstaande facturen via vriendelijke, korte WhatsApp berichten.

Regels:
- Schrijf in het Nederlands, tutoyeer
- Max 3-4 zinnen
- Vriendelijk maar zakelijk
- Bij betalingsbeloften: bevestig + bedank
- Bij financiele problemen: vraag door zonder oplossing aan te bieden, escaleer naar mens
- Bij verzoek om regeling: niet zelf onderhandelen, escaleer
- Geen specifieke betaalmogelijkheden of bankgegevens noemen tenzij gevraagd

Klant-context: {{customer_name}}, openstaand: EUR {{open_amount}} over {{open_invoice_count}} factuur of facturen.',
  '{"betaaltermijn_dagen": 14, "max_termijnen": 6}'::jsonb,
  'claude-sonnet-4-6',
  0.30,
  20,
  true
)
ON CONFLICT (module) DO UPDATE SET
  persona_name           = COALESCE(NULLIF(public.joost_config.persona_name, ''), EXCLUDED.persona_name),
  persona_tone           = COALESCE(NULLIF(public.joost_config.persona_tone, ''), EXCLUDED.persona_tone),
  system_prompt_template = COALESCE(NULLIF(public.joost_config.system_prompt_template, ''), EXCLUDED.system_prompt_template),
  knowledge_base         = CASE
                             WHEN public.joost_config.knowledge_base IS NULL
                               OR public.joost_config.knowledge_base = '{}'::jsonb
                             THEN EXCLUDED.knowledge_base
                             ELSE public.joost_config.knowledge_base
                           END,
  model                  = CASE
                             WHEN public.joost_config.model IS NULL
                               OR public.joost_config.model = ''
                             THEN EXCLUDED.model
                             ELSE public.joost_config.model
                           END,
  temperature            = CASE
                             WHEN public.joost_config.temperature IS NULL
                             THEN EXCLUDED.temperature
                             ELSE public.joost_config.temperature
                           END,
  context_message_count  = CASE
                             WHEN public.joost_config.context_message_count IS NULL
                               OR public.joost_config.context_message_count < 5
                             THEN EXCLUDED.context_message_count
                             ELSE public.joost_config.context_message_count
                           END,
  is_enabled             = true,
  updated_at             = now();

COMMIT;
