-- 2026-08-31-incasso-rls-hardening.sql  (v2 — herschreven na live-DB-check)
--
-- STATUS: TER REVIEW — NIET AUTOMATISCH DRAAIEN.
--
-- v1 was gebaseerd op de migratie-bestanden in de repo; live-DB-check
-- (pg_policies) toonde afwijkingen:
--   - 9 van de 13 eerder genoemde tabellen (payment_arrangements,
--     pending_actions, arrangement_action_settings, dunning_workflows,
--     dunning_workflow_steps, dunning_workflow_runs, dunning_templates,
--     dunning_log, payment_match_candidates) hebben RLS aan MAAR GEEN
--     policies gedefinieerd → default deny → al dicht. Aanscherping
--     zou een SELECT-policy toevoegen die 'em juist opent — mag NIET.
--   - Alleen 4 tabellen hebben nog een leeslek: SELECT-policy van vorm
--     `is_crm_staff() AND auth.uid() IS NOT NULL` — die is redundant en
--     laat elke CRM-staff-rol lezen. Die 4 scherpen we aan.
--
-- Wat dit doet:
--   Vervang de bestaande SELECT-policy op de volgende 4 tabellen:
--     1. dunning_call_log
--     2. dunning_phases        (roadmap: legacy, wachtend op audit)
--     3. dunning_trajectories  (roadmap: legacy, wachtend op audit)
--     4. payment_promises
--   door:
--     USING ( public.is_crm_staff()
--             AND public.has_any_role(ARRAY['super_admin','admin','manager','administratie']) )
--
--   Behoudt exact `TO public` en cmd `SELECT` zoals de bestaande policies.
--   Raak write-policies (USING (false) / WITH CHECK (false)) NIET aan.
--   Raak de 9 default-deny tabellen NIET aan.
--
-- Client-side callers (bevestigd read-only door greppen in modules/):
--   - Geen `.from('dunning_call_log'/'dunning_phases'/'dunning_trajectories'/
--     'payment_promises')` calls in modules/. Alleen 2 code-comments
--     (finance.html:8229 beschrijvende tekst; finance-views/roadmap.js:168
--     markeert dunning_phases + dunning_trajectories als LEGACY). Geen
--     legitieme niet-finance-lezer die stuk zou gaan door de aanscherping.
--
-- 0 incasso-writes. Geen dunning-/arrangement-code aangeraakt.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════
-- 1) dunning_call_log
-- ═══════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS dunning_call_log_select ON public.dunning_call_log;
CREATE POLICY dunning_call_log_select ON public.dunning_call_log
  FOR SELECT
  TO public
  USING (
    public.is_crm_staff()
    AND public.has_any_role(ARRAY['super_admin','admin','manager','administratie'])
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 2) dunning_phases  (legacy — schema-audit gepland)
-- ═══════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS dunning_phases_select ON public.dunning_phases;
CREATE POLICY dunning_phases_select ON public.dunning_phases
  FOR SELECT
  TO public
  USING (
    public.is_crm_staff()
    AND public.has_any_role(ARRAY['super_admin','admin','manager','administratie'])
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 3) dunning_trajectories  (legacy — schema-audit gepland)
-- ═══════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS dunning_trajectories_select ON public.dunning_trajectories;
CREATE POLICY dunning_trajectories_select ON public.dunning_trajectories
  FOR SELECT
  TO public
  USING (
    public.is_crm_staff()
    AND public.has_any_role(ARRAY['super_admin','admin','manager','administratie'])
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 4) payment_promises
-- ═══════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS payment_promises_select ON public.payment_promises;
CREATE POLICY payment_promises_select ON public.payment_promises
  FOR SELECT
  TO public
  USING (
    public.is_crm_staff()
    AND public.has_any_role(ARRAY['super_admin','admin','manager','administratie'])
  );

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- POST-CHECK
-- ═══════════════════════════════════════════════════════════════════════
--
-- 1. Verifieer dat alle 4 SELECT-policies aangescherpt zijn:
--    SELECT tablename, policyname, roles, cmd, qual
--    FROM pg_policies
--    WHERE tablename IN (
--      'dunning_call_log','dunning_phases','dunning_trajectories','payment_promises'
--    )
--      AND cmd = 'SELECT'
--    ORDER BY tablename;
--    -- Verwacht:
--    --   4 rijen, `roles = {public}`, cmd = SELECT.
--    --   `qual` bevat `is_crm_staff()` én `has_any_role`.
--    --   `qual` bevat NIET `auth.uid() IS NOT NULL`.
--
-- 2. Verifieer dat de 9 default-deny tabellen ongewijzigd zijn (geen
--    SELECT-policy):
--    SELECT tablename, cmd, policyname
--    FROM pg_policies
--    WHERE tablename IN (
--      'payment_arrangements','pending_actions','arrangement_action_settings',
--      'dunning_workflows','dunning_workflow_steps','dunning_workflow_runs',
--      'dunning_templates','dunning_log','payment_match_candidates'
--    )
--      AND cmd = 'SELECT';
--    -- Verwacht: 0 rijen (allemaal default deny gebleven).
--
-- 3. Test met een niet-finance-rol (bv. test-account als 'sales' of
--    'appointmentsetter') — via browser-console window.supabase:
--      const {data, error} = await window.supabase
--        .from('payment_promises').select('id').limit(5);
--      // Verwacht: data = [] (RLS filtert leeg).
--
-- 4. Test met een finance-rol (test-account als 'manager' of 'administratie'):
--      const {data, error} = await window.supabase
--        .from('payment_promises').select('id').limit(5);
--      // Verwacht: data bevat rijen.
--
-- 5. Server-endpoints (via service_role) blijven werken zonder verificatie
--    nodig — service_role omzeilt RLS altijd.
--
-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK (indien nodig — herstel naar pre-hardening state)
-- ═══════════════════════════════════════════════════════════════════════
--
-- BEGIN;
--   DROP POLICY IF EXISTS dunning_call_log_select ON public.dunning_call_log;
--   CREATE POLICY dunning_call_log_select ON public.dunning_call_log
--     FOR SELECT TO public
--     USING (public.is_crm_staff() AND (auth.uid() IS NOT NULL));
--
--   DROP POLICY IF EXISTS dunning_phases_select ON public.dunning_phases;
--   CREATE POLICY dunning_phases_select ON public.dunning_phases
--     FOR SELECT TO public
--     USING (public.is_crm_staff() AND (auth.uid() IS NOT NULL));
--
--   DROP POLICY IF EXISTS dunning_trajectories_select ON public.dunning_trajectories;
--   CREATE POLICY dunning_trajectories_select ON public.dunning_trajectories
--     FOR SELECT TO public
--     USING (public.is_crm_staff() AND (auth.uid() IS NOT NULL));
--
--   DROP POLICY IF EXISTS payment_promises_select ON public.payment_promises;
--   CREATE POLICY payment_promises_select ON public.payment_promises
--     FOR SELECT TO public
--     USING (public.is_crm_staff() AND (auth.uid() IS NOT NULL));
-- COMMIT;
