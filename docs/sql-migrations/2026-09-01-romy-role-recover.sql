-- 2026-09-01-romy-role-recover.sql
--
-- STATUS: TER REVIEW — NIET AUTOMATISCH DRAAIEN.
--
-- Herstel-SQL: zet Romy (administratie@dfoautomation.nl) terug naar
-- rol 'appointmentsetter'. Escalatie-oorzaak (bevestigd read-only):
-- fail-open mapRoleForShell in api/_lib/roles.js + admin.html invite-
-- dropdown default 'super_admin' + VALID_ROLES ontbrekende
-- 'appointmentsetter'.
--
-- KRITIEK draai-volgorde:
--   1. Code-deploy van bp2-role-escalation-fixes MOET LIVE zijn:
--      - api/_lib/roles.js fail-closed (mapRoleForShell → null default).
--      - api/admin-users.js VALID_ROLES bevat 'appointmentsetter'.
--      - modules/shared/design-system/roles.js fail-closed.
--   2. PAS DAARNA deze SQL draaien. Anders: shell/RBAC-caches tonen
--      Romy alsnog als super_admin ondanks de DB-restore, of vervolg-
--      pogingen om haar op appointmentsetter te zetten falen weer op
--      VALID_ROLES.
--
-- 0 incasso-writes. Alleen rol-mutaties op profiles/user_roles voor 1 user.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════
-- PRE-CHECK (draai eerst, verifieer wat er nu staat)
-- ═══════════════════════════════════════════════════════════════════════
--
-- SELECT p.id, p.email, p.role AS profile_role, p.is_active,
--        array_agg(ur.role) AS user_roles
-- FROM public.profiles p
-- LEFT JOIN public.user_roles ur ON ur.user_id = p.id
-- WHERE p.email = 'administratie@dfoautomation.nl'
-- GROUP BY p.id, p.email, p.role, p.is_active;
--
-- Verwacht: profile_role='super_admin', user_roles bevat 'super_admin'.
-- Als profile_role al 'appointmentsetter' is: draai deze migratie NIET
-- (dan is 'ie al gefixt of een ander scenario).

-- ═══════════════════════════════════════════════════════════════════════
-- HERSTEL — 3 statements binnen 1 transactie
-- ═══════════════════════════════════════════════════════════════════════

-- 1. profiles.role: super_admin → appointmentsetter.
UPDATE public.profiles
SET role       = 'appointmentsetter',
    updated_at = now()
WHERE email = 'administratie@dfoautomation.nl';

-- 2. user_roles: verwijder ALLE andere rollen (super_admin/sales/etc).
DELETE FROM public.user_roles
WHERE user_id = (SELECT id FROM public.profiles WHERE email = 'administratie@dfoautomation.nl')
  AND role <> 'appointmentsetter';

-- 3. user_roles: zorg dat appointmentsetter-rij bestaat (idempotent).
INSERT INTO public.user_roles (user_id, role, assigned_at)
SELECT id, 'appointmentsetter', now()
FROM public.profiles
WHERE email = 'administratie@dfoautomation.nl'
ON CONFLICT (user_id, role) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════
-- POST-CHECK (nog binnen dezelfde transactie — bevestigt correct)
-- ═══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_id           uuid;
  v_profile_role text;
  v_user_roles   text[];
  v_extra_count  int;
BEGIN
  SELECT id, role INTO v_id, v_profile_role
  FROM public.profiles WHERE email = 'administratie@dfoautomation.nl';

  SELECT array_agg(role ORDER BY role) INTO v_user_roles
  FROM public.user_roles WHERE user_id = v_id;

  SELECT count(*) INTO v_extra_count
  FROM public.user_roles WHERE user_id = v_id AND role <> 'appointmentsetter';

  IF v_profile_role <> 'appointmentsetter' THEN
    RAISE EXCEPTION 'HERSTEL MISLUKT: profiles.role = %, verwacht appointmentsetter', v_profile_role;
  END IF;
  IF v_extra_count > 0 THEN
    RAISE EXCEPTION 'HERSTEL MISLUKT: user_roles bevat nog % andere rijen: %',
      v_extra_count, v_user_roles;
  END IF;
  IF NOT ('appointmentsetter' = ANY(v_user_roles)) THEN
    RAISE EXCEPTION 'HERSTEL MISLUKT: user_roles ontbreekt appointmentsetter';
  END IF;
  RAISE NOTICE 'HERSTEL OK: profiles.role=appointmentsetter, user_roles=%', v_user_roles;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICATIE NA COMMIT (draai in aparte tab)
-- ═══════════════════════════════════════════════════════════════════════
--
-- 1. DB-state klopt:
--    SELECT p.id, p.email, p.role, ur.role
--    FROM public.profiles p LEFT JOIN public.user_roles ur ON ur.user_id = p.id
--    WHERE p.email = 'administratie@dfoautomation.nl';
--    -- Verwacht: 1 rij, beide role-kolommen = 'appointmentsetter'.
--
-- 2. Server ziet Romy niet meer als super_admin:
--    curl -H "Authorization: Bearer <romy-jwt>" \
--      https://forex-opleiding-interface.vercel.app/api/user-effective-roles
--    -- Verwacht:
--    --   { primary_role: "appointmentsetter",
--    --     roles: ["appointmentsetter"],
--    --     shell_roles: ["appointmentsetter"] }
--    -- BELANGRIJK: shell_roles bevat GEEN "super_admin" meer.
--
-- 3. Romy logt opnieuw in → landt op /modules/klanten-v2/#leadsonderhoud
--    (via ROLE_LANDING). Sidebar toont Leadsonderhoud + Commissie, GEEN
--    Finance/Admin/Sales/Mentor/Onboarding/Events/etc.
--
-- 4. Server-side gate-test:
--    curl -H "Authorization: Bearer <romy-jwt>" \
--      https://forex-opleiding-interface.vercel.app/api/finance-dashboard-counts
--    -- Verwacht: 403 "Geen rechten (finance.module.access)".
--
-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK (uitsluitend als POST-CHECK faalt — herstelt naar pre-run state)
-- ═══════════════════════════════════════════════════════════════════════
--
-- BEGIN;
--   -- Vervang <roles> door de rij(en) die je in de PRE-CHECK zag staan.
--   UPDATE public.profiles SET role='super_admin', updated_at=now()
--   WHERE email='administratie@dfoautomation.nl';
--
--   INSERT INTO public.user_roles (user_id, role, assigned_at)
--   SELECT id, 'super_admin', now() FROM public.profiles
--   WHERE email='administratie@dfoautomation.nl'
--   ON CONFLICT (user_id, role) DO NOTHING;
-- COMMIT;
