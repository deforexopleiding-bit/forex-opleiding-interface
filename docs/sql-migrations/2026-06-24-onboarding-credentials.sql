-- ============================================================================
-- Onboarding-credentials — schema + config-stub.
-- Datum: 2026-06-24
-- Branch: feat/onboarding-credentials-send
--
-- Twee onderdelen:
--   1) Schema-uitbreiding op public.onboardings — credentials_email_sent_at
--      en credentials_wa_sent_at om zichtbaarheid + idempotentie-marker te
--      bewaken. Toevoegen via ADD COLUMN IF NOT EXISTS is veilig idempotent.
--   2) Config-stub in public.joost_config (module='onboarding') — UPDATE op
--      knowledge_base->'credentials' met template_name='' (cron-/handmatige
--      WA-resend skipt totdat Jeffrey invult) + enabled=true (zodra
--      template_name gevuld is gaat 'ie aan).
--
-- BEIDE BLOKKEN ZIJN IDEMPOTENT — re-run is veilig.
--
-- TIJDELIJK WACHTWOORD wordt NOOIT gepersist — alleen meegegeven aan de
-- buitenwereld (mail/WA) en daarna verloren. Deze twee timestamps
-- registreren ALLEEN het tijdstip van verzenden, niet de waarde zelf.
-- ============================================================================

BEGIN;

-- ── A. onboardings.credentials_email_sent_at + credentials_wa_sent_at ─────
ALTER TABLE public.onboardings
  ADD COLUMN IF NOT EXISTS credentials_email_sent_at timestamptz;

ALTER TABLE public.onboardings
  ADD COLUMN IF NOT EXISTS credentials_wa_sent_at timestamptz;

COMMENT ON COLUMN public.onboardings.credentials_email_sent_at IS
  'Timestamp van de auto-verzonden welkomstmail met inloggegevens (vanuit '
  'api/_lib/onboarding-provision.js, na succesvolle STAP B). NULL = nog '
  'niet verzonden of e-mail niet ondersteund. Bevat GEEN wachtwoord.';

COMMENT ON COLUMN public.onboardings.credentials_wa_sent_at IS
  'Timestamp van de handmatige WhatsApp-fallback van inloggegevens (via '
  'api/onboarding-credentials-resend). NULL = nog niet verzonden. '
  'Bevat GEEN wachtwoord.';

-- ── B. joost_config.credentials-stub voor module='onboarding' ────────────
-- Default UIT door lege template_name (helper skipt met
-- reason=''geen-template-config''). Zodra Jeffrey de echte template-naam
-- invult is enabled=true al goed; zet 'enabled' op false om de hele
-- credentials-WA-flow tijdelijk uit te schakelen.
--
-- Hoe Jeffrey invult (PROD):
--   UPDATE public.joost_config
--   SET knowledge_base = jsonb_set(
--         coalesce(knowledge_base, '{}'::jsonb),
--         '{credentials}',
--         jsonb_build_object(
--           'template_name', '<naam-van-de-approved-credentials-template>',
--           'language',      'nl',
--           'enabled',       true
--         )
--       )
--   WHERE module = 'onboarding';
--
-- Variabelen die de credentials-WA-template kan gebruiken:
--   {{klant.voornaam}}            — voornaam van de student
--   {{klant.email}}               — gebruikersnaam (e-mailadres)
--   {{onboarding.login_url}}      — Bubble-dashboard-URL (env BUBBLE_LOGIN_URL)
--   {{onboarding.temp_password}}  — VERS tijdelijk wachtwoord (per resend opnieuw opgehaald)
--   {{bedrijf.naam}} / {{afdeling.*}}

UPDATE public.joost_config
SET knowledge_base = jsonb_set(
      coalesce(knowledge_base, '{}'::jsonb),
      '{credentials}',
      jsonb_build_object(
        'template_name', '',
        'language',      'nl',
        'enabled',       true
      ),
      true
    )
WHERE module = 'onboarding'
  AND NOT (coalesce(knowledge_base, '{}'::jsonb) ? 'credentials');

COMMIT;

-- Verificatie:
--   SELECT id, credentials_email_sent_at, credentials_wa_sent_at
--   FROM public.onboardings WHERE bubble_provisioned = true
--   ORDER BY bubble_provisioned_at DESC LIMIT 5;
--
--   SELECT module, knowledge_base->'credentials' AS credentials
--   FROM public.joost_config WHERE module='onboarding';
--
-- ROLLBACK schema:
--   ALTER TABLE public.onboardings DROP COLUMN IF EXISTS credentials_email_sent_at;
--   ALTER TABLE public.onboardings DROP COLUMN IF EXISTS credentials_wa_sent_at;
--   UPDATE public.joost_config
--     SET knowledge_base = knowledge_base - 'credentials'
--     WHERE module='onboarding';
