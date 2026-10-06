-- 2026-10-06 · WhatsApp-lead-modules naar het NIEUWE 360dialog-nummer.
--
-- Nieuwe 360dialog-account + nieuwe WABA + nieuw nummer. Meta's phone_number_id
-- van het nieuwe nummer: 1273723375834177 (opgevraagd via
-- GET https://waba-v2.360dialog.io/health_status?fields=id).
-- Vorige: 758003047390806 (oude account, 131042-betaalprobleem).
--
-- DATA-UPDATE, door Jeffrey te draaien NA:
--   1. Vercel-env: D360_API_KEY_HOOFDNUMMER = nieuwe key,
--      D360_PHONE_NUMBER_ID_HOOFDNUMMER = 1273723375834177 (+ redeploy);
--   2. de merge van de PR met de aangepaste hoofdnummer-entry (wa-nummers.js).
-- Draai je dit eerder, dan herkent de code het nieuwe nummer nog niet als
-- 360dialog-lijn en falen de lead-berichten.
--
-- Alleen leadsonderhoud + events. onboarding en finance blijven ongewijzigd.
-- Elk statement staat los (Supabase SQL-editor); herhaalbaar.

-- ── 0. Vooraf bekijken (alleen lezen) — uitkomst bewaren voor een rollback ──
-- SELECT module, phone_number_id, display_label, is_active, updated_at
--   FROM public.whatsapp_module_config ORDER BY module;

-- ── 1. Lead-modules naar het nieuwe nummer ───────────────────────────────────
UPDATE public.whatsapp_module_config
   SET phone_number_id = '1273723375834177',
       updated_at      = now()
 WHERE module IN ('leadsonderhoud', 'events')
   AND phone_number_id <> '1273723375834177';

-- ── 2. Controle (alleen lezen) ───────────────────────────────────────────────
-- SELECT module, phone_number_id, display_label FROM public.whatsapp_module_config ORDER BY module;
--   → leadsonderhoud + events = 1273723375834177; onboarding + finance ONGEWIJZIGD.

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- UPDATE public.whatsapp_module_config SET phone_number_id = '758003047390806', updated_at = now()
--  WHERE module IN ('leadsonderhoud', 'events');
