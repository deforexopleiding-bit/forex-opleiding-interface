-- ============================================================================
-- Migratie 044: Softphone/click-to-dial voor Chesney
-- Datum: 2026-08-26
-- Doel: Chesney (mentor, 9f4cd827-9529-4647-bdd3-2db4cd340bab) mag bellen
--       via de shared klx-softphone / Voys click-to-dial. Werkt overal waar
--       de softphone opgeroepen wordt: Follow-up werklijst, Klanten-dossier,
--       Wanbetalers-inbox, Events-inbox. Alleen Chesney; andere mentoren
--       ongewijzigd (Seppe krijgt niks).
--
-- Scope:
--   - Nieuwe key `softphone.use` (registry.js) — dedicated bel-recht.
--   - Alle 3 voys-endpoints (voys-call, voys-config, voys-sip-config)
--     accepteren deze key als extra OR-branch naast bestaande sales-keys.
--   - Per-user grant via user_permissions. Geen role_permissions-mutatie,
--     geen andere mentoren geraakt.
--
-- Voys-identiteit:
--   /api/voys-sip-config returnt de globale VOYS_SIP_*-env-vars (gedeeld
--   account). Geen per-user extensie/caller-ID nodig — de RBAC-grant is
--   voldoende. Chesney belt via het gedeelde NL-account (VOYS_A_NUMBER
--   als caller-ID) resp. BE-account.
--
-- Idempotent: ON CONFLICT (user_id, feature_key) DO UPDATE SET allowed=true.
-- ============================================================================

BEGIN;

INSERT INTO public.user_permissions (user_id, feature_key, allowed) VALUES
  ('9f4cd827-9529-4647-bdd3-2db4cd340bab', 'softphone.use', true)
ON CONFLICT (user_id, feature_key) DO UPDATE SET allowed = EXCLUDED.allowed;

COMMIT;

-- ============================================================================
-- VERIFICATIE (draai NA COMMIT)
-- ============================================================================
-- 1. Grant staat:
--    SELECT user_id, feature_key, allowed
--      FROM public.user_permissions
--     WHERE user_id = '9f4cd827-9529-4647-bdd3-2db4cd340bab'
--       AND feature_key = 'softphone.use';
--    Verwacht: allowed=true.
--
-- 2. RPC laat 'em door:
--    SELECT public.user_has_permission(
--      '9f4cd827-9529-4647-bdd3-2db4cd340bab'::uuid, 'softphone.use'
--    );
--    Verwacht: true.
--
-- 3. Sanity dat andere mentoren de grant NIET hebben (blast-radius = 0):
--    SELECT up.user_id, p.full_name
--      FROM public.user_permissions up
--      JOIN public.profiles p ON p.id = up.user_id
--     WHERE up.feature_key = 'softphone.use';
--    Verwacht: 1 rij (Chesney).
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- BEGIN;
-- UPDATE public.user_permissions
--    SET allowed = false
--  WHERE user_id = '9f4cd827-9529-4647-bdd3-2db4cd340bab'
--    AND feature_key = 'softphone.use';
-- -- Of definitief:
-- -- DELETE FROM public.user_permissions
-- --  WHERE user_id = '9f4cd827-9529-4647-bdd3-2db4cd340bab'
-- --    AND feature_key = 'softphone.use';
-- COMMIT;
-- ============================================================================
