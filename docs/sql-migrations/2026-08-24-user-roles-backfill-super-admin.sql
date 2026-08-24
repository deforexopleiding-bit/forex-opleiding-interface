-- 2026-08-24 · user_roles backfill — sync ontbrekende rijen vanuit profiles.role
--
-- CONTEXT
-- _lib/notify.js:101 doet role-fanout via user_roles-tabel. Diagnose toonde:
--   profiles-met-rol : 115
--   user_roles rijen : 114
--   ONTBREEKT        : user_id d16b1f94-80f5-4c6d-b2bf-530a331427c9
--                      (biemoldjeffrey@gmail.com, role='super_admin')
-- Sinds ~17 juli krijgt de super_admin daardoor GEEN meldingen meer via
-- toRole-fanout (notify returnt {ok:true,count:0} — stil geen ontvangers).
-- Directe toUserId-meldingen werken wél.
--
-- WAT DEZE MIGRATIE DOET
-- Idempotent: INSERT alleen rijen die in profiles.role bestaan maar NIET in
-- user_roles zitten. Verwijdert / wijzigt NIETS. profiles is de bron; drift
-- wordt hersteld richting user_roles.
--
-- Guardrails:
-- - Alleen rijen waar profiles.role IS NOT NULL en niet 'viewer'/'student'
--   (viewer/student horen niet in user_roles per CRM_STAFF_ROLES-scoping;
--   we blijven bij de bestaande whitelist zoals _lib/crm-roles.js).
-- - ON CONFLICT DO NOTHING — dubbel-runnen is veilig.
-- - RAISE NOTICE pre/post counts zodat je ziet wat er verandert.
--
-- CANONICALITEIT NOTITIE
-- CLAUDE.md documenteert profiles.role als canonieke rol-locatie, maar
-- _lib/notify.js + admin-users.js + RLS lezen nog user_roles. Verhelpen van
-- die drift op code-niveau is aparte brok (durability-advies onderaan).
-- Voor nu: user_roles backfillen zodat notify.js weer werkt.

BEGIN;

-- ═══ STAP 0 · PRE-COUNTS ═══════════════════════════════════════════════════
DO $$
DECLARE
  v_profiles_role  BIGINT;
  v_user_roles     BIGINT;
  v_missing        BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_profiles_role
    FROM public.profiles
    WHERE role IS NOT NULL
      AND role IN ('super_admin','admin','manager','sales','mentor','administratie','marketing');

  SELECT COUNT(*) INTO v_user_roles FROM public.user_roles;

  SELECT COUNT(*) INTO v_missing FROM public.profiles p
    WHERE p.role IS NOT NULL
      AND p.role IN ('super_admin','admin','manager','sales','mentor','administratie','marketing')
      AND NOT EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = p.id AND ur.role = p.role
      );

  RAISE NOTICE '── user_roles backfill PRE ────────────────────────────';
  RAISE NOTICE '  profiles met CRM-staff-rol   : %', v_profiles_role;
  RAISE NOTICE '  user_roles rijen (totaal)    : %', v_user_roles;
  RAISE NOTICE '  → ontbrekende rijen (INSERT) : %', v_missing;
END $$;

-- ═══ STAP 1 · BACKFILL ONTBREKENDE RIJEN ═══════════════════════════════════
-- INSERT alleen (user_id, role)-paren die in profiles staan maar niet in
-- user_roles. ON CONFLICT DO NOTHING vangt race-conditions op.
WITH inserted AS (
  INSERT INTO public.user_roles (user_id, role)
  SELECT p.id, p.role
  FROM public.profiles p
  WHERE p.role IS NOT NULL
    AND p.role IN ('super_admin','admin','manager','sales','mentor','administratie','marketing')
    AND NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = p.id AND ur.role = p.role
    )
  ON CONFLICT (user_id, role) DO NOTHING
  RETURNING user_id, role
)
SELECT
  (SELECT COUNT(*) FROM inserted) AS inserted_count,
  ARRAY_AGG(user_id::text || '|' || role) FILTER (WHERE user_id IS NOT NULL) AS inserted_pairs
FROM inserted;

-- ═══ STAP 2 · POST-VERIFICATIE ═════════════════════════════════════════════
DO $$
DECLARE
  v_profiles_role  BIGINT;
  v_user_roles     BIGINT;
  v_still_missing  BIGINT;
  v_superadmin_ok  BOOLEAN;
BEGIN
  SELECT COUNT(*) INTO v_profiles_role
    FROM public.profiles
    WHERE role IS NOT NULL
      AND role IN ('super_admin','admin','manager','sales','mentor','administratie','marketing');

  SELECT COUNT(*) INTO v_user_roles FROM public.user_roles;

  SELECT COUNT(*) INTO v_still_missing FROM public.profiles p
    WHERE p.role IS NOT NULL
      AND p.role IN ('super_admin','admin','manager','sales','mentor','administratie','marketing')
      AND NOT EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = p.id AND ur.role = p.role
      );

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = 'd16b1f94-80f5-4c6d-b2bf-530a331427c9'::uuid
      AND role = 'super_admin'
  ) INTO v_superadmin_ok;

  RAISE NOTICE '── user_roles backfill POST ───────────────────────────';
  RAISE NOTICE '  profiles met CRM-staff-rol   : %', v_profiles_role;
  RAISE NOTICE '  user_roles rijen (totaal)    : %', v_user_roles;
  RAISE NOTICE '  nog ontbrekend               : %', v_still_missing;
  RAISE NOTICE '  super_admin d16b1f94 aanwezig: %', v_superadmin_ok;
  IF v_still_missing > 0 THEN
    RAISE WARNING 'Er ontbreken nog % rijen — check profiles WHERE role IN (...) AND NOT EXISTS(user_roles).', v_still_missing;
  END IF;
  IF NOT v_superadmin_ok THEN
    RAISE WARNING 'super_admin-rij nog niet aanwezig na backfill — check profiles.role voor user d16b1f94.';
  END IF;
END $$;

COMMIT;
