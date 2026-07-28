-- ============================================================================
-- Reserveringsfee-bypass — role-grants voor de nieuwe permission-key
-- Datum: 2026-07-28
-- Branch: fix/reservation-fee-bypass
--
-- Key: `sales.reservation_fee.bypass` — geeft de gebruiker het recht om bij
-- abonnement-invoer de €100 reserveringsfee te omzeilen (aparte factuur wordt
-- NIET geboekt, late-start-guard wordt overgeslagen). Server-side gecheckt in
-- api/sales-subscription-create.js — vinkje verbergen in de UI is puur
-- cosmetisch; endpoint weigert de bypass zonder deze permission met 403.
--
-- Rol-toewijzing (bewust APART van sales.deal.create zodat 'ie los intrekbaar is):
--   sales   → allowed (Jeffreys sales-team mag omzeilen; on-hold-cases zijn hun brood)
--   manager → allowed
--   admin   → allowed
--   super_admin → heeft * (wildcard) — geen expliciete grant nodig
--
-- Idempotent via NOT EXISTS — veilig te herhalen.
-- ============================================================================

BEGIN;

-- ── sales ────────────────────────────────────────────────────────────────
INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'sales', 'sales.reservation_fee.bypass', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_permissions rp
  WHERE rp.role = 'sales' AND rp.feature_key = 'sales.reservation_fee.bypass'
);

-- ── manager ──────────────────────────────────────────────────────────────
INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'manager', 'sales.reservation_fee.bypass', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_permissions rp
  WHERE rp.role = 'manager' AND rp.feature_key = 'sales.reservation_fee.bypass'
);

-- ── admin ────────────────────────────────────────────────────────────────
INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'admin', 'sales.reservation_fee.bypass', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_permissions rp
  WHERE rp.role = 'admin' AND rp.feature_key = 'sales.reservation_fee.bypass'
);

COMMIT;

-- ROLLBACK (indien nodig — trekt de permission bij alle 3 rollen in):
-- DELETE FROM public.role_permissions
-- WHERE feature_key = 'sales.reservation_fee.bypass'
--   AND role IN ('sales','manager','admin');
