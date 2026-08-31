-- 2026-08-31-incasso-rls-hardening.sql
--
-- STATUS: TER REVIEW — NIET AUTOMATISCH DRAAIEN.
-- Aanleiding: de incasso-tabellen hebben RLS-SELECT-policies van vorm
-- `USING (auth.uid() IS NOT NULL)`. Elke ingelogde CRM-staff-rol kan die
-- data dus lezen via een directe browser-Supabase-call, ook rollen die
-- niets met finance/incasso te maken hebben (sales, mentor, marketing,
-- appointmentsetter). De server-side requirePermission-gate is nu de enige
-- echte bescherming. Deze migratie dicht dat op DB-niveau.
--
-- Wat dit doet:
--   Vervangt de SELECT-policy van vorm `USING (auth.uid() IS NOT NULL)`
--   op de incasso-tabellen door:
--     USING ( public.is_crm_staff()
--             AND public.has_any_role(ARRAY['super_admin','admin','manager','administratie']) )
--
--   Zo blijven super_admin/admin/manager/administratie hun toegang houden
--   (zij bedienen de finance-module) en verliezen sales/mentor/marketing/
--   appointmentsetter hun directe DB-leesrecht — die horen deze data
--   ook niet te zien.
--
-- Wat dit NIET doet:
--   - Geen dunning-/arrangement-logica of code aangeraakt (alleen policies).
--   - Geen WRITE-policies aangepast — die staan al op `USING (false)` /
--     `WITH CHECK (false)`, dus alleen service_role kan al schrijven.
--   - `app_settings` blijft ongemoeid: bevat brede settings (sidebar_layout,
--     sales/events/webflow config, dunning-flags) en wordt uitsluitend via
--     server-endpoints gelezen. Geen directe browser-Supabase-callers
--     gevonden voor `app_settings`. Aanscherping niet nodig, aanscherping
--     zou risico op regressies elders geven.
--   - Andere finance-tabellen buiten incasso-scope (invoices, payments,
--     bank_*, deals, subscriptions, invoices-related) worden NIET geraakt
--     — user vroeg specifiek naar incasso-scope. Bredere hardening kan
--     later in een aparte migratie.
--
-- Tabellen in scope (alle huidig `USING (auth.uid() IS NOT NULL)`):
--   1.  payment_arrangements               (D1 — 2026-06-09-payment-arrangements-d1.sql:196)
--   2.  pending_actions                    (D1 — 2026-06-09-payment-arrangements-d1.sql:209)
--   3.  arrangement_action_settings        (D1 — 2026-06-09-payment-arrangements-d1.sql:222)
--   4.  dunning_workflows                  (2026-06-07-dunning-foundation.sql:97)
--   5.  dunning_workflow_steps             (2026-06-07-dunning-foundation.sql:102)
--   6.  dunning_workflow_runs              (2026-06-07-dunning-foundation.sql:107)
--   7.  dunning_templates                  (2026-06-07-dunning-foundation.sql:112)
--   8.  dunning_log                        (2026-06-07-dunning-foundation.sql:117)
--   9.  payment_match_candidates           (2026-06-06-payment-match-candidates.sql:53)
--   10. dunning_call_log                   (2026-07-14-dunning-call-log.sql:56)
--   11. dunning_trajectories               (2026-05-30-finance-fase-1-fundament.sql loop)
--   12. dunning_phases                     (2026-05-30-finance-fase-1-fundament.sql loop)
--   13. payment_promises                   (2026-05-30-finance-fase-1-fundament.sql loop)
--
-- Legitieme client-side lezer:
--   modules/finance.html:8465 — `supa.from('dunning_workflow_runs')` in
--   het dunning-run-paneel van klantdetail. Comment zegt "ADMIN_ROLES
--   hebben toegang". De nieuwe policy behoudt die: manager/admin/super_admin
--   zitten in de whitelist, dus dat paneel blijft werken.
--   Alle andere incasso-data-toegang loopt via server-endpoints (service_role),
--   die RLS sowieso omzeilen — dus zij zijn onaffected.
--
-- 0 incasso-writes. Raakt geen dunning-/arrangement-code aan.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════
-- 1) D1 payment_arrangements + pending_actions + arrangement_action_settings
-- ═══════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS payment_arrangements_select ON public.payment_arrangements;
CREATE POLICY payment_arrangements_select ON public.payment_arrangements
  FOR SELECT USING (
    public.is_crm_staff()
    AND public.has_any_role(ARRAY['super_admin','admin','manager','administratie'])
  );

DROP POLICY IF EXISTS pending_actions_select ON public.pending_actions;
CREATE POLICY pending_actions_select ON public.pending_actions
  FOR SELECT USING (
    public.is_crm_staff()
    AND public.has_any_role(ARRAY['super_admin','admin','manager','administratie'])
  );

DROP POLICY IF EXISTS arrangement_action_settings_select ON public.arrangement_action_settings;
CREATE POLICY arrangement_action_settings_select ON public.arrangement_action_settings
  FOR SELECT USING (
    public.is_crm_staff()
    AND public.has_any_role(ARRAY['super_admin','admin','manager','administratie'])
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 2) Dunning-foundation (workflows, steps, runs, templates, log)
-- ═══════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS dunning_wf_select ON public.dunning_workflows;
CREATE POLICY dunning_wf_select ON public.dunning_workflows
  FOR SELECT USING (
    public.is_crm_staff()
    AND public.has_any_role(ARRAY['super_admin','admin','manager','administratie'])
  );

DROP POLICY IF EXISTS dunning_steps_select ON public.dunning_workflow_steps;
CREATE POLICY dunning_steps_select ON public.dunning_workflow_steps
  FOR SELECT USING (
    public.is_crm_staff()
    AND public.has_any_role(ARRAY['super_admin','admin','manager','administratie'])
  );

DROP POLICY IF EXISTS dunning_runs_select ON public.dunning_workflow_runs;
CREATE POLICY dunning_runs_select ON public.dunning_workflow_runs
  FOR SELECT USING (
    public.is_crm_staff()
    AND public.has_any_role(ARRAY['super_admin','admin','manager','administratie'])
  );

DROP POLICY IF EXISTS dunning_tpl_select ON public.dunning_templates;
CREATE POLICY dunning_tpl_select ON public.dunning_templates
  FOR SELECT USING (
    public.is_crm_staff()
    AND public.has_any_role(ARRAY['super_admin','admin','manager','administratie'])
  );

DROP POLICY IF EXISTS dunning_log_select ON public.dunning_log;
CREATE POLICY dunning_log_select ON public.dunning_log
  FOR SELECT USING (
    public.is_crm_staff()
    AND public.has_any_role(ARRAY['super_admin','admin','manager','administratie'])
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 3) Payment matching + call log
-- ═══════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS pmc_select ON public.payment_match_candidates;
CREATE POLICY pmc_select ON public.payment_match_candidates
  FOR SELECT USING (
    public.is_crm_staff()
    AND public.has_any_role(ARRAY['super_admin','admin','manager','administratie'])
  );

DROP POLICY IF EXISTS dunning_call_log_select ON public.dunning_call_log;
CREATE POLICY dunning_call_log_select ON public.dunning_call_log
  FOR SELECT USING (
    public.is_crm_staff()
    AND public.has_any_role(ARRAY['super_admin','admin','manager','administratie'])
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 4) Finance-fase-1 dunning-tabellen (trajectories, phases, promises)
-- ═══════════════════════════════════════════════════════════════════════
--
-- Deze policies zijn dynamisch aangemaakt in 2026-05-30-finance-fase-1-fundament.sql
-- via een DO-loop: `CREATE POLICY <t>_select ON public.<t> FOR SELECT
-- USING (auth.uid() IS NOT NULL)`. Naming-convention: <table>_select.

DROP POLICY IF EXISTS dunning_trajectories_select ON public.dunning_trajectories;
CREATE POLICY dunning_trajectories_select ON public.dunning_trajectories
  FOR SELECT USING (
    public.is_crm_staff()
    AND public.has_any_role(ARRAY['super_admin','admin','manager','administratie'])
  );

DROP POLICY IF EXISTS dunning_phases_select ON public.dunning_phases;
CREATE POLICY dunning_phases_select ON public.dunning_phases
  FOR SELECT USING (
    public.is_crm_staff()
    AND public.has_any_role(ARRAY['super_admin','admin','manager','administratie'])
  );

DROP POLICY IF EXISTS payment_promises_select ON public.payment_promises;
CREATE POLICY payment_promises_select ON public.payment_promises
  FOR SELECT USING (
    public.is_crm_staff()
    AND public.has_any_role(ARRAY['super_admin','admin','manager','administratie'])
  );

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- POST-CHECK
-- ═══════════════════════════════════════════════════════════════════════
--
-- 1. Verifieer alle 13 SELECT-policies zijn aangescherpt:
--    SELECT tablename, policyname, qual
--    FROM pg_policies
--    WHERE tablename IN (
--      'payment_arrangements','pending_actions','arrangement_action_settings',
--      'dunning_workflows','dunning_workflow_steps','dunning_workflow_runs',
--      'dunning_templates','dunning_log','payment_match_candidates',
--      'dunning_call_log','dunning_trajectories','dunning_phases','payment_promises'
--    )
--      AND cmd = 'SELECT'
--    ORDER BY tablename;
--    -- Verwacht: `qual` bevat `is_crm_staff()` én `has_any_role`.
--    -- Verwacht NIET: `qual = (auth.uid() IS NOT NULL)` op deze rijen.
--
-- 2. Test met een sales/mentor/marketing-account (via SQL-editor "Impersonate"
--    of via de app met een echte test-user):
--      SELECT count(*) FROM public.payment_arrangements;   -- verwacht: 0 / permission denied
--      SELECT count(*) FROM public.pending_actions;         -- verwacht: 0 / permission denied
--
-- 3. Test met een manager/administratie-account:
--      SELECT count(*) FROM public.payment_arrangements;   -- verwacht: N (echte data)
--      SELECT count(*) FROM public.pending_actions;         -- verwacht: N
--
-- 4. Test finance-module UI met een manager-account:
--    - Open /modules/finance.html → Wanbetalers-tab werkt.
--    - Klantdetail → dunning-run-paneel (modules/finance.html:8458)
--      toont "Actief" / "Gepauzeerd" i.p.v. leeg vak.
--
-- 5. Server-endpoints blijven werken (via service_role omzeilen RLS altijd).
--
-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK (indien nodig — herstel naar pre-hardening state)
-- ═══════════════════════════════════════════════════════════════════════
--
-- BEGIN;
--   -- Herstel naar `USING (auth.uid() IS NOT NULL)`:
--   DROP POLICY IF EXISTS payment_arrangements_select ON public.payment_arrangements;
--   CREATE POLICY payment_arrangements_select ON public.payment_arrangements
--     FOR SELECT USING (auth.uid() IS NOT NULL);
--
--   DROP POLICY IF EXISTS pending_actions_select ON public.pending_actions;
--   CREATE POLICY pending_actions_select ON public.pending_actions
--     FOR SELECT USING (auth.uid() IS NOT NULL);
--
--   DROP POLICY IF EXISTS arrangement_action_settings_select ON public.arrangement_action_settings;
--   CREATE POLICY arrangement_action_settings_select ON public.arrangement_action_settings
--     FOR SELECT USING (auth.uid() IS NOT NULL);
--
--   DROP POLICY IF EXISTS dunning_wf_select ON public.dunning_workflows;
--   CREATE POLICY dunning_wf_select ON public.dunning_workflows
--     FOR SELECT USING (auth.uid() IS NOT NULL);
--
--   DROP POLICY IF EXISTS dunning_steps_select ON public.dunning_workflow_steps;
--   CREATE POLICY dunning_steps_select ON public.dunning_workflow_steps
--     FOR SELECT USING (auth.uid() IS NOT NULL);
--
--   DROP POLICY IF EXISTS dunning_runs_select ON public.dunning_workflow_runs;
--   CREATE POLICY dunning_runs_select ON public.dunning_workflow_runs
--     FOR SELECT USING (auth.uid() IS NOT NULL);
--
--   DROP POLICY IF EXISTS dunning_tpl_select ON public.dunning_templates;
--   CREATE POLICY dunning_tpl_select ON public.dunning_templates
--     FOR SELECT USING (auth.uid() IS NOT NULL);
--
--   DROP POLICY IF EXISTS dunning_log_select ON public.dunning_log;
--   CREATE POLICY dunning_log_select ON public.dunning_log
--     FOR SELECT USING (auth.uid() IS NOT NULL);
--
--   DROP POLICY IF EXISTS pmc_select ON public.payment_match_candidates;
--   CREATE POLICY pmc_select ON public.payment_match_candidates
--     FOR SELECT USING (auth.uid() IS NOT NULL);
--
--   DROP POLICY IF EXISTS dunning_call_log_select ON public.dunning_call_log;
--   CREATE POLICY dunning_call_log_select ON public.dunning_call_log
--     FOR SELECT USING (auth.uid() IS NOT NULL);
--
--   DROP POLICY IF EXISTS dunning_trajectories_select ON public.dunning_trajectories;
--   CREATE POLICY dunning_trajectories_select ON public.dunning_trajectories
--     FOR SELECT USING (auth.uid() IS NOT NULL);
--
--   DROP POLICY IF EXISTS dunning_phases_select ON public.dunning_phases;
--   CREATE POLICY dunning_phases_select ON public.dunning_phases
--     FOR SELECT USING (auth.uid() IS NOT NULL);
--
--   DROP POLICY IF EXISTS payment_promises_select ON public.payment_promises;
--   CREATE POLICY payment_promises_select ON public.payment_promises
--     FOR SELECT USING (auth.uid() IS NOT NULL);
-- COMMIT;
