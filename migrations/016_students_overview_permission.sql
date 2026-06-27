-- ──────────────────────────────────────────────────────────────────────────────
-- Migratie 016: students.all.view — admin-brede studenten-overzichtspagina
-- ──────────────────────────────────────────────────────────────────────────────
-- Doel: nieuwe RBAC-key 'students.all.view' die de /modules/students-overview.html
-- pagina + /api/students-overview endpoint gate't. Manager krijgt 'm; super_admin
-- bypasst alle role_permissions via '*' en is dus niet expliciet vereist.
--
-- Geen andere rollen — sales/mentor/marketing/administratie/viewer mogen géén
-- org-brede studentenlijst zien (alleen super_admin + manager).
--
-- Idempotent: ON CONFLICT (role, feature_key) DO UPDATE SET allowed.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

INSERT INTO public.role_permissions (role, feature_key, allowed) VALUES
  ('manager', 'students.all.view', true)
ON CONFLICT (role, feature_key) DO UPDATE
  SET allowed = EXCLUDED.allowed;

COMMIT;

-- Rollback (handmatig):
-- DELETE FROM public.role_permissions
--  WHERE feature_key = 'students.all.view' AND role = 'manager';
