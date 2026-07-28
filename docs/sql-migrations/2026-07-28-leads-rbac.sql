-- ============================================================================
-- Leads-module — role-grants voor de 3 nieuwe permission-keys
-- Datum: 2026-07-28
-- Branch: feat/leads-module
--
-- Keys (staan in modules/admin.html PERMISSION_CATALOG na deze PR):
--   leads.view    — leads-module openen + lijsten lezen + detail + tellers
--   leads.update  — status/notitie/eigenaar wijzigen (whitelist server-side)
--   leads.promote — lead doorzetten naar customers (klant aanmaken/linken)
--
-- Rol-toewijzing:
--   sales   → view + update + promote (kernrol voor lead-opvolging)
--   mentor  → view                    (mag inzien, niet muteren)
--   manager → view + update + promote
--   admin   → view + update + promote
--   super_admin heeft * (wildcard) — geen expliciete grant nodig
--
-- Idempotent (NOT EXISTS). Veilig te herhalen.
-- ============================================================================

BEGIN;

-- ── sales ────────────────────────────────────────────────────────────────
INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'sales', 'leads.view', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='sales' AND feature_key='leads.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'sales', 'leads.update', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='sales' AND feature_key='leads.update');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'sales', 'leads.promote', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='sales' AND feature_key='leads.promote');

-- ── mentor (alleen view) ─────────────────────────────────────────────────
INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'mentor', 'leads.view', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='mentor' AND feature_key='leads.view');

-- ── manager ──────────────────────────────────────────────────────────────
INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'manager', 'leads.view', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='manager' AND feature_key='leads.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'manager', 'leads.update', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='manager' AND feature_key='leads.update');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'manager', 'leads.promote', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='manager' AND feature_key='leads.promote');

-- ── admin ────────────────────────────────────────────────────────────────
INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'admin', 'leads.view', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='admin' AND feature_key='leads.view');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'admin', 'leads.update', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='admin' AND feature_key='leads.update');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'admin', 'leads.promote', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='admin' AND feature_key='leads.promote');

COMMIT;

-- ROLLBACK (indien nodig):
-- DELETE FROM public.role_permissions
-- WHERE feature_key IN ('leads.view','leads.update','leads.promote')
--   AND role IN ('sales','mentor','manager','admin');
