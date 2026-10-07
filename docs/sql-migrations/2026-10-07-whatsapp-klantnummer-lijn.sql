-- 2026-10-07 · Klantnummer (360dialog) als lijn voor finance + onboarding.
--              Door Jeffrey te draaien — PAS als D360_API_KEY_KLANTNUMMER,
--              D360_PHONE_NUMBER_ID_KLANTNUMMER en D360_WEBHOOK_TOKEN_KLANTNUMMER
--              in Vercel staan, de webhook op ?nummer=klantnummer staat en de
--              klant-templates APPROVED zijn op de nieuwe WABA.
--
-- WAT
--   whatsapp_module_config: de rijen 'finance' en 'onboarding' wijzen naar het
--   klantnummer (phone_number_id 1399327383258229). Er bestaat GEEN aparte
--   'dunning'-rij: dunning verstuurt via module 'finance'.
--
-- business_account_id
--   De inbox-templatelijst filtert whatsapp_meta_templates op de
--   business_account_id van de lijn. Alle CRM-templaterijen staan op
--   990429800401598 (de oude WABA) en dezelfde namen worden op de nieuwe WABA
--   ingediend (scripts/360-templates-upload.mjs --nummer=klantnummer). Daarom
--   houden beide rijen 990429800401598 — onboarding stond op NULL en krijgt 'm
--   nu ook, zodat de onboarding-inbox dezelfde lijst toont als finance.
--   (Templatenamen gaan 1-op-1 mee naar 360dialog; de WABA-id in onze tabel is
--   alleen een filtersleutel voor de lijst.)
--
-- ROLLBACK (onderaan): terug naar de oude lijn-ID's.

-- ── 0. Vooraf (alleen lezen) ─────────────────────────────────────────────────
-- SELECT module, phone_number_id, business_account_id, is_active
--   FROM public.whatsapp_module_config ORDER BY module;
-- Verwacht nu: finance 1194351613761790 / 990429800401598,
--              onboarding 1163203046877082 / NULL.

-- ── 1. Omzetten ──────────────────────────────────────────────────────────────
UPDATE public.whatsapp_module_config
   SET phone_number_id = '1399327383258229',
       business_account_id = coalesce(business_account_id, '990429800401598')
 WHERE module = 'finance' AND phone_number_id = '1194351613761790';

UPDATE public.whatsapp_module_config
   SET phone_number_id = '1399327383258229',
       business_account_id = coalesce(business_account_id, '990429800401598')
 WHERE module = 'onboarding' AND phone_number_id = '1163203046877082';

-- ── 2. Controle (alleen lezen) ───────────────────────────────────────────────
-- SELECT module, phone_number_id, business_account_id, is_active
--   FROM public.whatsapp_module_config WHERE module IN ('finance','onboarding');
-- Verwacht: beide 1399327383258229 / 990429800401598.

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- UPDATE public.whatsapp_module_config SET phone_number_id = '1194351613761790'
--  WHERE module = 'finance' AND phone_number_id = '1399327383258229';
-- UPDATE public.whatsapp_module_config SET phone_number_id = '1163203046877082', business_account_id = NULL
--  WHERE module = 'onboarding' AND phone_number_id = '1399327383258229';
