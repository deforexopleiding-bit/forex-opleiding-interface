-- 2026-09-01-bp2-scope-uitbreiding-rechten.sql
--
-- STATUS: TER REVIEW — NIET AUTOMATISCH DRAAIEN.
--
-- BP2 scope-uitbreiding voor Romy (appointmentsetter): 2 nieuwe grants
-- voor dashboard-zichtbaarheid + lead-mutaties (extend-access, toegang-
-- verlenen). Fail-closed principe: minimaal wat nodig is, niks meer.
--
-- Wat dit doet:
--   - Grant `dashboard.module.access` → appointmentsetter kan de
--     Dashboard-module openen (nieuwe dashSetter() render-variant komt
--     in de code-deploy).
--   - Grant `leads.update` → appointmentsetter mag:
--       * bestaande verlengen-toegang endpoint aanroepen
--         (api/leadsonderhoud-extend-access.js)
--       * de nieuwe "Geef toegang"-endpoint aanroepen (komt in code).
--     Blijft achter de bestaande endpoint-gates zodat scope-checks
--     server-side autoritatief blijven.
--
-- Wat dit NIET doet:
--   - Geen leads.delete / leads.promote / leads.bulk.* — Romy krijgt
--     geen destructieve of promote-acties.
--   - Geen finance.*, sales.*, mentor.*, onboarding.*, events.* — geen
--     enkele finance/omzet/deal-toegang.
--   - Geen admin.module.access / admin.joost_config.
--   - Geen wijziging aan bestaande grants voor andere rollen (manager,
--     admin, super_admin krijgen geen nieuwe keys — die hebben ze al
--     via bestaande RBAC-seeds of via super_admin wildcard).
--
-- 0 incasso-writes. Alleen role_permissions-seed voor 1 rol.
-- Incasso-zone (finance.html, dunning*, arrangement*, pending-action*,
-- _lib/dunning-*, _lib/register-payment-internal.js, _lib/mentor-*)
-- onaangeroerd.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════
-- Seed: 2 nieuwe grants voor 'appointmentsetter'
-- ═══════════════════════════════════════════════════════════════════════
--
-- ON CONFLICT DO NOTHING → idempotent (herhaalde runs = no-op).
-- Bestaande grants voor appointmentsetter blijven ongewijzigd:
--   leads.view, snippets.view, snippets.manage,
--   admin.meta_templates.manage, setter.ledger.view

INSERT INTO public.role_permissions (role, feature_key, allowed) VALUES
  -- Dashboard-module openen (nieuwe rol-variant dashSetter() rendert
  -- daar met exclusief setter-gescoped metrics; nooit finance/omzet).
  ('appointmentsetter', 'dashboard.module.access', true),

  -- Lead-mutaties: extend-access + geef-toegang (trial-provisioning).
  -- Endpoint-side scope-check (setter-scope helper) zorgt dat Romy
  -- alleen haar eigen leads muteert, niet die van anderen.
  ('appointmentsetter', 'leads.update',            true)
ON CONFLICT (role, feature_key) DO NOTHING;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- POST-CHECK
-- ═══════════════════════════════════════════════════════════════════════
--
-- Verifieer 7 rijen totaal voor appointmentsetter:
--   SELECT role, feature_key FROM public.role_permissions
--   WHERE role = 'appointmentsetter'
--   ORDER BY feature_key;
--   -- verwacht:
--   --   admin.meta_templates.manage
--   --   dashboard.module.access
--   --   leads.update
--   --   leads.view
--   --   setter.ledger.view
--   --   snippets.manage
--   --   snippets.view
--
-- Server-side test (na code-deploy) — Romy krijgt 200 op extend-access,
-- 403 op finance-endpoints:
--   curl -H "Authorization: Bearer <romy-jwt>" \
--     -X POST https://forex-opleiding-interface.vercel.app/api/leadsonderhoud-extend-access \
--     -d '{"lead_id":"<test-uuid>","duur":"30d"}'
--   -- verwacht: 200 (of validatie-fout op de test-uuid, geen 403).
--
--   curl -H "Authorization: Bearer <romy-jwt>" \
--     https://forex-opleiding-interface.vercel.app/api/finance-dashboard-counts
--   -- verwacht: 403 "Geen rechten (finance.module.access)".
--
-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK (indien nodig)
-- ═══════════════════════════════════════════════════════════════════════
--
-- BEGIN;
--   DELETE FROM public.role_permissions
--   WHERE role = 'appointmentsetter'
--     AND feature_key IN ('dashboard.module.access', 'leads.update');
-- COMMIT;
