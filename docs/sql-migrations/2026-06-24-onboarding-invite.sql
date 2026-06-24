-- ============================================================================
-- Comms — Onboarding-invite FASE C1 — schema + config-stub.
-- Datum: 2026-06-24
-- Branch: feat/comms-onboarding-invite
--
-- Twee onderdelen:
--   1) Schema-uitbreiding op public.onboardings — kolom invite_sent_at om
--      idempotentie te bewaken (helper-skip wanneer reeds verzonden, force=true
--      overschrijft). Toevoegen via ADD COLUMN IF NOT EXISTS is veilig
--      idempotent.
--   2) Config-stub in public.joost_config (module='onboarding') — UPDATE op
--      knowledge_base->'invite' met placeholder. Jeffrey vult template_name
--      handmatig in zodra de Meta-template APPROVED is.
--
-- BEIDE BLOKKEN ZIJN IDEMPOTENT — re-run is veilig.
-- ============================================================================

BEGIN;

-- ── A. onboardings.invite_sent_at ─────────────────────────────────────────
ALTER TABLE public.onboardings
  ADD COLUMN IF NOT EXISTS invite_sent_at timestamptz;

COMMENT ON COLUMN public.onboardings.invite_sent_at IS
  'Timestamp van de laatste succesvol verzonden WhatsApp-onboarding-invite. '
  'NULL = nog niet verstuurd. Idempotentie-gate in api/_lib/onboarding-invite.js: '
  'helper skipt sturen wanneer gevuld, tenzij force=true (operator-knop "Opnieuw versturen").';

-- ── B. joost_config.invite-stub voor module='onboarding' ──────────────────
-- Voeg een placeholder-blok toe aan knowledge_base.invite. Het veld
-- template_name is bewust LEEG zodat de helper de invite-flow skipt
-- ({sent:false, reason:'geen-template-config'}) totdat Jeffrey de echte
-- Meta-template-naam invult. enabled=true is default; zet 'm op false om
-- de hele invite-flow tijdelijk uit te schakelen.
--
-- Hoe Jeffrey invult (PROD):
--   UPDATE public.joost_config
--   SET knowledge_base = jsonb_set(
--         coalesce(knowledge_base, '{}'::jsonb),
--         '{invite}',
--         jsonb_build_object(
--           'template_name', '<naam-van-de-approved-meta-template>',
--           'language',      'nl',
--           'enabled',       true
--         )
--       )
--   WHERE module = 'onboarding';
--
-- Variabelen die de template kan gebruiken:
--   {{klant.voornaam}}                — voornaam van de student
--   {{klant.naam}}                    — voor- + achternaam
--   {{onboarding.wizard_link}}        — persoonlijke wizard-URL (token)
--   {{onboarding.traject_label}}      — label van het gekozen traject
--   {{onboarding.status}}             — 'aangemeld' / 'bezig' / etc.
--   {{bedrijf.naam}} / {{afdeling.*}} — bestaande named-vars

UPDATE public.joost_config
SET knowledge_base = jsonb_set(
      coalesce(knowledge_base, '{}'::jsonb),
      '{invite}',
      jsonb_build_object(
        'template_name', '',
        'language',      'nl',
        'enabled',       true
      ),
      true
    )
WHERE module = 'onboarding'
  AND NOT (coalesce(knowledge_base, '{}'::jsonb) ? 'invite');

COMMIT;

-- Verificatie:
--   SELECT id, invite_sent_at FROM public.onboardings WHERE invite_sent_at IS NOT NULL LIMIT 5;
--   SELECT module, knowledge_base->'invite' AS invite FROM public.joost_config WHERE module='onboarding';
--
-- ROLLBACK schema:
--   ALTER TABLE public.onboardings DROP COLUMN IF EXISTS invite_sent_at;
--   UPDATE public.joost_config SET knowledge_base = knowledge_base - 'invite' WHERE module='onboarding';
