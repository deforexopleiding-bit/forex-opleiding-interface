-- ============================================================================
-- Comms — Onboarding-inbox FASE B1 — RBAC-keys.
-- Datum: 2026-06-24
-- Branch: feat/comms-onboarding-inbox-b1
--
-- Drie nieuwe feature-keys die default aan manager + admin worden toegekend
-- (zelfde patroon als 2026-06-04-finance-payment-permissions.sql en
-- 2026-06-05-finance-write-permissions.sql). super_admin krijgt alles
-- automatisch via user_has_permission() — geen rij nodig. Overige rollen
-- (sales, mentor, administratie, viewer) krijgen NIETS by default; een admin
-- kan dat per gebruiker toekennen via de rechten-matrix in /modules/admin.html.
--
-- Idempotent: NOT EXISTS-guard zodat re-run veilig is.
-- ============================================================================

BEGIN;

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT r, k, true
FROM (VALUES ('manager'), ('admin')) AS roles(r)
CROSS JOIN (VALUES
  ('onboarding.inbox.view'),   -- list / messages / context / mark-read
  ('onboarding.inbox.send'),   -- inbox-send + send-template + customer-link
  ('onboarding.mila.use')      -- "Vraag Mila"-knop / onboarding-suggest endpoint
) AS keys(k)
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_permissions rp
  WHERE rp.role = roles.r AND rp.feature_key = keys.k
);

COMMIT;

-- Verificatie:
--   SELECT role, feature_key, allowed FROM public.role_permissions
--   WHERE feature_key IN (
--     'onboarding.inbox.view','onboarding.inbox.send','onboarding.mila.use'
--   ) ORDER BY feature_key, role;
--
-- ROLLBACK:
--   DELETE FROM public.role_permissions
--   WHERE feature_key IN (
--     'onboarding.inbox.view','onboarding.inbox.send','onboarding.mila.use'
--   );
