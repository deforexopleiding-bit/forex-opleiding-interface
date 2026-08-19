-- ============================================================================
-- CRM RLS — HARDENING: rolcheck afdwingen op elke zwakke policy
-- Datum: 2026-08-19
-- Project: forex-command-center (Supabase ref nsjnsvlmdhunzqkdvagm)
-- Branch: claude/crm-rls-role-check-k3dqiq
--
-- ⚠ DRAAI EERST docs/sql-migrations/2026-08-19-crm-rls-audit-weak-policies.sql
--   (read-only) en bewaar de output. Dat is je nulmeting én je bewijs.
--
-- PROBLEEM
-- handle_new_user() maakt bij elk nieuw auth-account automatisch een
-- public.profiles-rij aan met rol 'viewer' (of 'student'). Een deel van de
-- RLS-policies checkt alleen of dát profiel bestaat:
--     EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid())
-- Zonder rolcheck kan dus iedere ingelogde student CRM-data lezen (leads, …).
--
-- OPLOSSING — WRAP, NIET VERVANGEN
-- Elke zwakke policy krijgt de bestaande expressie ONGEWIJZIGD terug, met er
-- een rolpoort vóór:
--     USING ( public.is_crm_staff() AND ( <oude expressie> ) )
-- Voor CRM-staff geeft is_crm_staff() true, dus `true AND <oud>` = <oud>:
-- exact dezelfde toegang als nu, geen enkele policy die strenger wordt voor
-- staff. Voor viewer/student klapt de poort dicht op ALLE gewrapte tabellen.
--
-- Op public.profiles en public.user_roles is de poort ruimer, zodat iedere
-- gebruiker zijn EIGEN rij blijft lezen (nodig voor login + de rol-guard van
-- het LMS):
--     USING ( ( public.is_crm_staff() OR id = auth.uid() ) AND ( <oud> ) )
--
-- IDEMPOTENT
-- Policies die al `is_crm_staff` bevatten worden overgeslagen. Het bestand mag
-- zo vaak gedraaid worden als je wilt; de tweede run past 0 policies aan.
--
-- NIET AANGERAAKT (bewust)
--   • public.lms_students        — trials-stroom via de website van een collega
--   • public.lms_*  / public.hlms_*  — LMS/student-facing; die worden door
--     studenten zelf met hun eigen JWT gelezen. Ze staan in de audit-output
--     onder "handmatig beoordelen".
--   • policies die alleen voor anon/service_role gelden
--   • policies zonder verwijzing naar auth.uid()/profiles (bv. `USING (true)`)
--
-- ROLLBACK: docs/sql-migrations/2026-08-19-crm-rls-role-check-rollback.sql
-- ============================================================================


-- ── 1) Logtabel — bewijs + rollback-bron ────────────────────────────────────
-- Permanent (geen TEMP): de Supabase SQL-editor knipt input op
-- statement-grenzen, een TEMP-tabel zou tussen twee statements verdwijnen.
CREATE TABLE IF NOT EXISTS public.rls_hardening_log (
  id              bigserial PRIMARY KEY,
  run_id          uuid        NOT NULL,
  schemaname      text        NOT NULL,
  tablename       text        NOT NULL,
  policyname      text        NOT NULL,
  cmd             text,
  roles           text[],
  old_qual        text,
  old_with_check  text,
  new_qual        text,
  new_with_check  text,
  applied_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.rls_hardening_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_hardening_log_select_admin ON public.rls_hardening_log;
CREATE POLICY rls_hardening_log_select_admin ON public.rls_hardening_log
  FOR SELECT USING (public.is_super_admin());


-- ── 2) is_crm_staff() — de rolpoort ─────────────────────────────────────────
-- SECURITY DEFINER + STABLE, net als is_super_admin(): draait als owner en
-- omzeilt RLS, zodat een policy die deze functie aanroept GEEN recursie op
-- profiles/user_roles veroorzaakt.
--
-- WHITELIST, geen blacklist. Een rol die hier niet in staat krijgt GEEN
-- toegang. Daarmee is het lek blijvend dicht: een nieuwe rol (of de default
-- 'viewer'/'student' uit handle_new_user) komt er nooit vanzelf doorheen.
--
-- De lijst bevat alle 7 medewerkersrollen uit VALID_ROLES (api/admin-users.js).
-- 'viewer' en 'student' staan er BEWUST niet in — dat zijn de student-accounts.
-- Wil je later strikter (alleen super_admin/sales/mentor): pas uitsluitend de
-- ARRAY hieronder aan en draai dit statement opnieuw. Let op dat je daarmee
-- ook admin/manager/administratie/marketing buitensluit — o.a. het account
-- van Jeffrey (rol 'manager') en de leads-rechten uit
-- docs/sql-migrations/2026-07-28-leads-rbac.sql.
CREATE OR REPLACE FUNCTION public.is_crm_staff()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
    WHERE ur.user_id = auth.uid()
      AND p.is_active = true
      AND ur.role = ANY (ARRAY[
            'super_admin', 'admin', 'manager', 'sales',
            'mentor', 'administratie', 'marketing'
          ]::text[])
  )
  OR EXISTS (
    -- Vangnet voor accounts die (nog) geen user_roles-rij hebben; spiegelt
    -- has_any_role() uit migrations/002-rbac-foundation.sql.
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.is_active = true
      AND p.role = ANY (ARRAY[
            'super_admin', 'admin', 'manager', 'sales',
            'mentor', 'administratie', 'marketing'
          ]::text[])
  );
$$;

COMMENT ON FUNCTION public.is_crm_staff() IS
  'True als auth.uid() een ACTIEF profiel heeft met een CRM-medewerkersrol. '
  'Whitelist: viewer/student en onbekende rollen krijgen false. '
  'Gebruikt als rolpoort in RLS-policies (2026-08-19 hardening).';

GRANT EXECUTE ON FUNCTION public.is_crm_staff() TO authenticated, anon;


-- ── 3) De rewrite ───────────────────────────────────────────────────────────
-- Eén DO-block (de Supabase SQL-editor draait elk statement in een eigen
-- transactie — zie CLAUDE.md; state mag dus niet over blokken heen leven).
-- Alles-of-niets: een fout op één policy rolt het hele blok terug.
DO $do$
DECLARE
  r          record;
  v_run_id   uuid := gen_random_uuid();
  v_gate     text;
  v_sql      text;
  v_new_q    text;
  v_new_c    text;
  v_total    int  := 0;
BEGIN
  FOR r IN
    SELECT p.schemaname, p.tablename, p.policyname, p.cmd, p.roles,
           p.qual, p.with_check
    FROM pg_policies p
    WHERE p.schemaname = 'public'
      -- alleen policies die voor ingelogde gebruikers gelden
      AND p.roles && ARRAY['authenticated','public']::name[]
      -- verwijst naar de ingelogde gebruiker → bedoeld als auth-poort
      AND (COALESCE(p.qual,'') || ' ' || COALESCE(p.with_check,'')) ~* '(auth\.uid\(\)|profiles)'
      -- ... maar bevat GEEN enkele rolcheck → dit is het lek
      AND (COALESCE(p.qual,'') || ' ' || COALESCE(p.with_check,''))
          !~* '(is_crm_staff|is_super_admin|has_any_role|user_has_permission|user_roles|\mrole\M)'
      -- uitsluitingen: trials + LMS/student-facing (zie kop van dit bestand)
      AND p.tablename <> 'lms_students'
      AND p.tablename NOT LIKE 'lms\_%'
      AND p.tablename NOT LIKE 'hlms\_%'
      AND p.tablename <> 'rls_hardening_log'
    ORDER BY p.tablename, p.policyname
  LOOP
    -- Rolpoort bepalen. Op profiles/user_roles blijft de eigen rij leesbaar,
    -- anders kan een student niet meer inloggen en breekt de LMS-rol-guard.
    v_gate := CASE r.tablename
                WHEN 'profiles'   THEN '(public.is_crm_staff() OR id = auth.uid())'
                WHEN 'user_roles' THEN '(public.is_crm_staff() OR user_id = auth.uid())'
                ELSE                   'public.is_crm_staff()'
              END;

    v_new_q := NULL;
    v_new_c := NULL;
    v_sql   := format('ALTER POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);

    IF r.qual IS NOT NULL THEN
      v_new_q := format('%s AND (%s)', v_gate, r.qual);
      v_sql   := v_sql || format(' USING (%s)', v_new_q);
    END IF;

    IF r.with_check IS NOT NULL THEN
      v_new_c := format('%s AND (%s)', v_gate, r.with_check);
      v_sql   := v_sql || format(' WITH CHECK (%s)', v_new_c);
    END IF;

    -- Policy zonder qual én zonder with_check bestaat niet; defensief skippen.
    IF v_new_q IS NULL AND v_new_c IS NULL THEN
      RAISE WARNING 'Overgeslagen (geen expressie): %.% / %',
        r.schemaname, r.tablename, r.policyname;
      CONTINUE;
    END IF;

    EXECUTE v_sql;

    INSERT INTO public.rls_hardening_log (
      run_id, schemaname, tablename, policyname, cmd, roles,
      old_qual, old_with_check, new_qual, new_with_check
    ) VALUES (
      v_run_id, r.schemaname, r.tablename, r.policyname, r.cmd, r.roles::text[],
      r.qual, r.with_check, v_new_q, v_new_c
    );

    v_total := v_total + 1;
    RAISE NOTICE 'Gehard: %.% / % (%)', r.schemaname, r.tablename, r.policyname, r.cmd;
  END LOOP;

  RAISE NOTICE '--- klaar: % policies gehard, run_id = % ---', v_total, v_run_id;
END
$do$;


-- ── 4) Wat is er aangepast? (lijst voor de PR) ──────────────────────────────
SELECT tablename, policyname, cmd, applied_at
FROM public.rls_hardening_log
ORDER BY applied_at DESC, tablename, policyname;


-- ── 5) Restlek-check — hoort 0 rijen te geven ───────────────────────────────
SELECT p.tablename, p.policyname, p.cmd, p.qual, p.with_check
FROM pg_policies p
WHERE p.schemaname = 'public'
  AND p.roles && ARRAY['authenticated','public']::name[]
  AND (COALESCE(p.qual,'') || ' ' || COALESCE(p.with_check,'')) ~* '(auth\.uid\(\)|profiles)'
  AND (COALESCE(p.qual,'') || ' ' || COALESCE(p.with_check,''))
      !~* '(is_crm_staff|is_super_admin|has_any_role|user_has_permission|user_roles|\mrole\M)'
  AND p.tablename <> 'lms_students'
  AND p.tablename NOT LIKE 'lms\_%'
  AND p.tablename NOT LIKE 'hlms\_%'
ORDER BY p.tablename, p.policyname;
