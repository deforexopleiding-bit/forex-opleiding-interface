-- ============================================================================
-- Migratie 040: E-mail-toegang voor rol sales
-- Datum: 2026-08-25
-- Doel: Sales-rol krijgt `email.module.access` zodat de v2-shell E-mail-item
--       (roles: SAMS in app-shell.js) niet meer op een 403 klapt.
--
-- Scope-uitbreiding (bewust, in overleg met Jeffrey):
--   Voorheen enkel manager + super_admin. Sales voegt zich hierbij; postvak-
--   scope wordt NIET fijnmazig per rol beperkt — email-inbox-list.js
--   respecteert dezelfde alles-of-niets gate als in v1. Sales ziet dus
--   dezelfde 4 postvakken (leads/info/partners/administratie) als manager.
--   Fijnmazige postvak-scoping is out-of-scope voor deze migratie.
--
-- Idempotent (ON CONFLICT DO NOTHING). Bij herhaald draaien blijft bestaande
-- state ongewijzigd. Rollback:
--   DELETE FROM public.role_permissions
--    WHERE role='sales' AND feature_key='email.module.access';
--
-- Verificatie:
--   SELECT role, feature_key, allowed
--     FROM public.role_permissions
--    WHERE feature_key = 'email.module.access'
--    ORDER BY role;
-- Verwacht: manager + sales (allebei allowed=true). super_admin heeft geen
-- rij nodig (RPC-bypass). Andere rollen zoals mentor/marketing/administratie
-- niet in de lijst.
-- ============================================================================

BEGIN;

INSERT INTO public.role_permissions (role, feature_key, allowed) VALUES
  ('sales', 'email.module.access', true)
ON CONFLICT (role, feature_key) DO NOTHING;

COMMIT;
