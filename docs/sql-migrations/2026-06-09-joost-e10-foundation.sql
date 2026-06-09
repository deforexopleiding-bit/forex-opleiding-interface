-- =============================================================================
-- Joost AI — E1.0 fundament (config + suggestions)
-- Datum: 2026-06-09
-- Branch: feat/joost-e10-foundation
--
-- Doel:
--   Introduceert het DB-fundament voor 'Joost' — een AI-assistent die in de
--   finance-inbox suggesties genereert voor antwoorden op klant-WhatsApp's.
--   Twee tabellen:
--
--     1. joost_config       — per-module configuratie (persona, prompt,
--                              knowledge_base, model, temperature, enabled).
--                              module text PRIMARY KEY (1 rij per module).
--     2. joost_suggestions  — log van iedere gegenereerde suggestie + outcome
--                              (gebruikt / aangepast / genegeerd / dismissed).
--                              context_snapshot jsonb voor audit + later eval.
--
-- Architectuur-notes:
--   * Tabel-namen volgen finance-conventie (Engels): customers / invoices.
--   * RLS pattern (consistent met whatsapp_module_config):
--       - SELECT authenticated (UI moet kunnen lezen)
--       - Write USING(false) WITH CHECK(false) — alleen via service-role
--         vanuit /api/admin-joost-config (super_admin gate) of
--         /api/joost-suggest (RBAC finance.joost.use gate).
--   * updated_at-trigger pattern: kopie uit whatsapp_module_config (regel 65-80).
--   * Seed: 1 rij voor module='finance' met de eerste prompt-template +
--     knowledge_base zoals afgesproken in E1.0-spec.
--
-- Idempotent: BEGIN/COMMIT + IF NOT EXISTS + ON CONFLICT DO NOTHING.
-- Veilig om opnieuw te draaien.
--
-- -- Verifie-queries na uitvoeren --------------------------------------------
-- SELECT module, persona_name, model, temperature, is_enabled
--   FROM joost_config ORDER BY module;
-- SELECT id, conversation_id, status, created_at
--   FROM joost_suggestions ORDER BY created_at DESC LIMIT 5;
-- SELECT polname, polcmd FROM pg_policies
--   WHERE tablename IN ('joost_config','joost_suggestions');
-- =============================================================================

BEGIN;

-- ===========================================================================
-- 1. joost_config — per-module configuratie
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.joost_config (
  module                  text PRIMARY KEY,
  persona_name            text NOT NULL DEFAULT 'Joost',
  persona_tone            text NOT NULL DEFAULT 'vriendelijk-professioneel',
  system_prompt_template  text NOT NULL DEFAULT '',
  knowledge_base          jsonb NOT NULL DEFAULT '{}'::jsonb,
  model                   text NOT NULL DEFAULT 'claude-sonnet-4-6',
  temperature             numeric(3,2) NOT NULL DEFAULT 0.30,
  context_message_count   integer NOT NULL DEFAULT 10,
  is_enabled              boolean NOT NULL DEFAULT true,
  updated_by_user_id      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.joost_config IS
  'Per-module configuratie voor Joost AI-assistent (1 rij per module). Persona, system-prompt, knowledge_base, model + temperature en feature-flag.';
COMMENT ON COLUMN public.joost_config.module IS
  'Interne module-key (lowercase, snake-case). Bv. finance, sales, support. PRIMARY KEY = 1 rij per module.';
COMMENT ON COLUMN public.joost_config.persona_name IS
  'Naam waarmee Joost zichzelf aanduidt. Default: Joost.';
COMMENT ON COLUMN public.joost_config.persona_tone IS
  'Korte beschrijving van de toon (vriendelijk-professioneel, formeel, casual). Vrije tekst.';
COMMENT ON COLUMN public.joost_config.system_prompt_template IS
  'System-prompt template met named-placeholders ({klant.naam}, {facturen.totaal_open_bedrag}, ...). Resolution gebeurt server-side in joost-suggest endpoint.';
COMMENT ON COLUMN public.joost_config.knowledge_base IS
  'Vrije jsonb-blob met module-specifieke kennis (betaalmogelijkheden, IBAN, support-uren, bedrijfsnaam, etc). Wordt mee-gerendered in system-prompt.';
COMMENT ON COLUMN public.joost_config.model IS
  'Anthropic model-string. Default claude-sonnet-4-6. Override mogelijk per module via admin-UI.';
COMMENT ON COLUMN public.joost_config.temperature IS
  'Sampling temperature (0.00 - 1.00). Lager = consistenter, hoger = creatiever.';
COMMENT ON COLUMN public.joost_config.context_message_count IS
  'Aantal recente WhatsApp-berichten (in + out gemengd) dat als context wordt meegegeven aan de LLM-call.';

CREATE OR REPLACE FUNCTION public.joost_config_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_joost_config_touch ON public.joost_config;
CREATE TRIGGER trg_joost_config_touch
  BEFORE UPDATE ON public.joost_config
  FOR EACH ROW EXECUTE FUNCTION public.joost_config_touch_updated_at();

-- ===========================================================================
-- 2. joost_suggestions — log + outcome
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.joost_suggestions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id          uuid REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE,
  triggered_by_message_id  uuid REFERENCES public.whatsapp_messages(id) ON DELETE SET NULL,
  module                   text NOT NULL DEFAULT 'finance',
  suggested_reply          text NOT NULL,
  detected_intent          text,
  confidence               numeric(4,3),
  reasoning                text,
  context_snapshot         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                   text NOT NULL DEFAULT 'PROPOSED'
                             CHECK (status IN ('PROPOSED','USED_AS_IS','USED_EDITED','IGNORED','DISMISSED')),
  final_sent_text          text,
  outcome_notes            text,
  requested_by_user_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  used_by_user_id          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  used_at                  timestamptz
);

COMMENT ON TABLE  public.joost_suggestions IS
  'Log van iedere door Joost gegenereerde suggestie + outcome (PROPOSED -> USED_AS_IS/USED_EDITED/IGNORED/DISMISSED). context_snapshot bevat de jsonb-input waarmee gegenereerd is voor reproduceerbaarheid.';
COMMENT ON COLUMN public.joost_suggestions.conversation_id IS
  'WhatsApp-conversatie waarvoor de suggestie gegenereerd is.';
COMMENT ON COLUMN public.joost_suggestions.triggered_by_message_id IS
  'Inbound message die de suggestie triggerde (meestal de laatste klant-message in de thread).';
COMMENT ON COLUMN public.joost_suggestions.context_snapshot IS
  'Volledige context-jsonb (customer, open_invoices, actieve_afspraak, afdeling, bedrijf, recent_messages) zoals meegegeven aan de LLM. Audit + later eval.';
COMMENT ON COLUMN public.joost_suggestions.status IS
  'PROPOSED -> USED_AS_IS (1-op-1 verstuurd), USED_EDITED (aangepast verstuurd), IGNORED (genegeerd zonder dismiss), DISMISSED (expliciet weggeklikt).';
COMMENT ON COLUMN public.joost_suggestions.final_sent_text IS
  'De werkelijk verstuurde tekst (kan afwijken van suggested_reply bij USED_EDITED).';

CREATE INDEX IF NOT EXISTS idx_joost_sugg_conv
  ON public.joost_suggestions (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_joost_sugg_status
  ON public.joost_suggestions (status, created_at DESC);

-- ===========================================================================
-- 3. RLS
-- ===========================================================================
ALTER TABLE public.joost_config       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.joost_suggestions  ENABLE ROW LEVEL SECURITY;

-- joost_config: read authenticated, write blocked (service-role only)
DROP POLICY IF EXISTS joost_config_read_authenticated ON public.joost_config;
CREATE POLICY joost_config_read_authenticated
  ON public.joost_config
  FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS joost_config_no_write ON public.joost_config;
CREATE POLICY joost_config_no_write
  ON public.joost_config
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);

-- joost_suggestions: read authenticated, write blocked (service-role only)
DROP POLICY IF EXISTS joost_suggestions_read_authenticated ON public.joost_suggestions;
CREATE POLICY joost_suggestions_read_authenticated
  ON public.joost_suggestions
  FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS joost_suggestions_no_write ON public.joost_suggestions;
CREATE POLICY joost_suggestions_no_write
  ON public.joost_suggestions
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);

-- ===========================================================================
-- 4. Seed: finance config (E1.0 default prompt + knowledge_base)
-- ===========================================================================
INSERT INTO public.joost_config
  (module, persona_name, persona_tone, system_prompt_template, knowledge_base,
   model, temperature, context_message_count, is_enabled)
VALUES (
  'finance',
  'Joost',
  'vriendelijk-professioneel',
  'Je bent Joost, een vriendelijke maar professionele incasso-medewerker van De Forex Opleiding B.V. Je helpt klanten met openstaande facturen via WhatsApp. Belangrijk:
- Schrijf in goed Nederlands, vriendelijk en duidelijk.
- Gebruik tutoyeer-vorm tenzij anders aangegeven.
- Bij betalingsbeloftes: vraag naar concrete datum en bedrag.
- Bij verify-payment claims: vraag naar datum, bedrag, IBAN waar overgemaakt.
- Bij betalingsregeling-vragen: leg uit dat collega Jeffrey de mogelijkheden bespreekt.
- Verwijs NIET naar interne systemen of TL of bank-feed.
- Houd berichten compact (max 3-4 zinnen).

Context wordt mee gegeven via dynamic vars: klant naam, open facturen totaal, actieve afspraak.',
  '{
    "betaalmogelijkheden": "iDeal of bankoverschrijving naar NL95 ABNA 0123 4567 89",
    "bedrijfsnaam": "De Forex Opleiding B.V.",
    "support_uren": "ma-vr 9u-17u"
  }'::jsonb,
  'claude-sonnet-4-6',
  0.30,
  10,
  true
)
ON CONFLICT (module) DO NOTHING;

COMMIT;
