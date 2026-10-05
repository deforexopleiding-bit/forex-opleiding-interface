-- 2026-10-05 · WhatsApp-lijnen omzetten naar het 360dialog-hoofdnummer (+31 6 57210825).
--
-- DATA-UPDATE, door Jeffrey te draaien NA het zetten van de Vercel-env
-- (D360_API_KEY_HOOFDNUMMER) en NA de merge van de 360dialog-PR.
-- Geen schemawijziging; de code werkt ook zonder deze stappen (lead-sends gaan
-- dan nog naar de oude, geblokkeerde Meta-lijn en falen zoals nu).
--
-- <PNID> = Meta's phone_number_id van het hoofdnummer. Ophalen (één keer):
--   curl -H "D360-API-KEY: <key>" "https://waba-v2.360dialog.io/health_status?fields=id"
--   → het veld "id". Zet die waarde ook in Vercel als D360_PHONE_NUMBER_ID_HOOFDNUMMER.
-- (De eerste inkomende webhook logt hem ook: "[whatsapp-360-webhook] hoofdnummer: phone_number_id=…".)
--
-- Wat er verhuist: de LEAD-modules. Klant-modules NIET:
--   onboarding → geen WhatsApp tot een eigen nummer (e-mail-fallback, zie PR)
--   finance    → wanbetalers/Joost/Iris: beslissing Jeffrey (blijft nu op de oude lijn)
--
-- De Supabase SQL-editor draait elk statement los; deze statements zijn
-- onafhankelijk en herhaalbaar.

-- ── 0. Vooraf bekijken (alleen lezen) ────────────────────────────────────────
-- SELECT module, phone_number_id, business_account_id, display_label, is_active
--   FROM public.whatsapp_module_config ORDER BY module;
-- SELECT value FROM public.app_settings WHERE key = 'leadsonderhoud_wa_module';
-- SELECT value FROM public.app_settings WHERE key = 'opvolging_agenda_doorsturen';

-- ── 1. Lead-modules naar het hoofdnummer ─────────────────────────────────────
-- leadsonderhoud = welkom/afspraken/toegang/onderhoud/gesprekken (resolveWelkomPhoneId,
-- cron-leadsonderhoud, opvolging-agenda via module 'leadsonderhoud');
-- events = uitnodigingen/vragenlijsten/automations; welkom = legacy-rij.
-- business_account_id blijft staan: de inbox-templatelijst filtert daarop en de
-- templates in whatsapp_meta_templates hangen (nog) aan de oude WABA-id.
UPDATE public.whatsapp_module_config
   SET phone_number_id = '<PNID>',
       display_label   = display_label || ' (360dialog)',
       updated_at      = now()
 WHERE module IN ('leadsonderhoud', 'events', 'welkom')
   AND phone_number_id <> '<PNID>';

-- ── 2. Leadsonderhoud-gesprekken/bulk niet meer via de onboarding-lijn ───────
-- haalLijn() las 'onboarding' (seed 2026-07-30). Leads horen op het hoofdnummer.
UPDATE public.app_settings
   SET value = to_jsonb('leadsonderhoud'::text)
 WHERE key = 'leadsonderhoud_wa_module'
   AND value = to_jsonb('onboarding'::text);

-- ── 3. (Alleen als stap 0 een vaste phone_number_id liet zien) ───────────────
-- Agenda doorsturen (opvolging) volgt anders de module 'leadsonderhoud'.
-- UPDATE public.app_settings
--    SET value = value - 'phone_number_id'
--  WHERE key = 'opvolging_agenda_doorsturen' AND value ? 'phone_number_id';

-- ── 4. Controle (alleen lezen) ───────────────────────────────────────────────
-- SELECT module, phone_number_id, display_label FROM public.whatsapp_module_config ORDER BY module;
--   → leadsonderhoud/events/welkom = <PNID>; onboarding en finance ONGEWIJZIGD.

-- ── 5. Welke templates gebruiken de lead-flows uit de database? (alleen lezen) ─
-- SELECT DISTINCT meta_template FROM public.onderhoud_sjablonen WHERE meta_template IS NOT NULL;
-- SELECT DISTINCT s->'config'->>'template_name' AS template
--   FROM public.event_automations, jsonb_array_elements(steps) s
--  WHERE s->'config'->>'template_name' IS NOT NULL;
-- SELECT name, status, language, business_account_id FROM public.whatsapp_meta_templates ORDER BY name;

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- Zet phone_number_id per module terug op de waarde uit stap 0, en:
-- UPDATE public.app_settings SET value = to_jsonb('onboarding'::text) WHERE key = 'leadsonderhoud_wa_module';
