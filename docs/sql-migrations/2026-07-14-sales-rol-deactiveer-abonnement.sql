-- ============================================================================
-- 2026-07-14 — Sales-rol: toegang tot deactiveren van abonnementen
--
-- CONTEXT: de sales-rol moet vanuit /modules/sales.html → Abonnementen
-- → "Deactiveren" een abo kunnen deactiveren. Beide gates:
--   1. UI-tab-zichtbaarheid    → `sales.tab.subscriptions`  (al true in seed 015)
--   2. Endpoint-gate           → `sales.deal.edit`          (al true in seed 014)
--
-- api/sales-subscription-delete.js roept `requirePermission(req,
-- 'sales.deal.edit')` aan. Als productie afwijkt van de seed (rij ontbreekt
-- of allowed=false) faalt de endpoint met 403 en/of de knop verschijnt niet.
--
-- Deze migratie GARANDEERT die twee specifieke rijen op `allowed=true`.
-- Idempotent: bij bestaande rijen wordt alleen `allowed` bijgewerkt naar
-- true (indien nodig); andere rollen en andere feature_keys blijven
-- onaangeroerd. GEEN over-granting — precies de twee benodigde permissies,
-- niets extra.
--
-- Als de rijen al correct staan is dit een no-op.
-- ============================================================================

BEGIN;

INSERT INTO public.role_permissions (role, feature_key, allowed) VALUES
  ('sales', 'sales.deal.edit',         true),
  ('sales', 'sales.tab.subscriptions', true)
ON CONFLICT (role, feature_key) DO UPDATE
  SET allowed = EXCLUDED.allowed;

-- Verificatie: bevestig dat beide rijen nu op true staan.
DO $$
DECLARE
  v_edit_ok  boolean;
  v_tab_ok   boolean;
BEGIN
  SELECT allowed INTO v_edit_ok
    FROM public.role_permissions
   WHERE role = 'sales' AND feature_key = 'sales.deal.edit';
  SELECT allowed INTO v_tab_ok
    FROM public.role_permissions
   WHERE role = 'sales' AND feature_key = 'sales.tab.subscriptions';
  IF NOT COALESCE(v_edit_ok, false) OR NOT COALESCE(v_tab_ok, false) THEN
    RAISE EXCEPTION 'Sales-rol permissies niet correct gezet: sales.deal.edit=%, sales.tab.subscriptions=%',
      v_edit_ok, v_tab_ok;
  END IF;
END $$;

COMMIT;
