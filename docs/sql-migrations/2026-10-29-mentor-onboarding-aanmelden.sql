-- ============================================================================
-- Mentor-rol: "Onboarding aanmelden" na een getekende offerte
-- Datum: 2026-10-29
--
-- WAT HET DOET
-- Zet het recht onboarding.create aan voor de ROL mentor (role_permissions).
-- Elke huidige én toekomstige mentor krijgt het dus automatisch; er staat
-- niets per persoon.
--
-- WAAROM DIT RECHT
-- De knop "📋 Onboarding aanmelden" (offerte-detail, status accepted/signed)
-- heeft in de browser geen eigen rolcheck. Wat hem tegenhoudt zit op de server,
-- en beide endpoints achter de knop vragen hetzelfde recht:
--   GET  /api/onboarding-trajecten-list  -> requirePermission('onboarding.create')
--        (vult de keuzelijst met trajecten in het venster)
--   POST /api/onboarding-create          -> requirePermission('onboarding.create')
--        (maakt de onboarding aan)
-- Zonder dit recht opent het venster wel, maar blijft de trajectlijst leeg en
-- geeft Aanmelden een 403. Met deze ene rij werken UI en server allebei.
--
-- Andere rollen en rechten worden niet aangeraakt.
--
-- IDEMPOTENT: ON CONFLICT (role, feature_key) DO UPDATE SET allowed = true.
-- Staat er al een rij op false (bv. via de rechten-matrix), dan gaat die op true.
-- ============================================================================


-- ── CONTROLE VOORAF (alleen lezen) ──────────────────────────────────────────
-- Hoe staat onboarding.create nu per rol? (geen rij = niet toegestaan)
SELECT role, allowed
  FROM public.role_permissions
 WHERE feature_key = 'onboarding.create'
 ORDER BY role;


-- ── WIJZIGING ───────────────────────────────────────────────────────────────
INSERT INTO public.role_permissions (role, feature_key, allowed)
VALUES ('mentor', 'onboarding.create', true)
ON CONFLICT (role, feature_key) DO UPDATE SET allowed = true;


-- ── CONTROLE ACHTERAF (alleen lezen) ────────────────────────────────────────
-- 1) Verwacht: mentor | true
SELECT role, allowed
  FROM public.role_permissions
 WHERE feature_key = 'onboarding.create' AND role = 'mentor';

-- 2) Kan een mentor de offerte zelf openen? De knop staat op de offerte-detail,
--    en die laadt via /api/sales-deal-detail (recht sales.deal.view). Staat
--    hieronder ergens false, dan ziet een mentor de offerte (en dus de knop)
--    niet. Deze migratie verandert dat bewust NIET; meld het, dan beslissen we
--    apart.
SELECT k.feature_key,
       coalesce(rp.allowed, false) AS mentor_mag
  FROM (VALUES ('sales.deal.view'), ('sales.tab.quotations'), ('onboarding.create')) AS k(feature_key)
  LEFT JOIN public.role_permissions rp
         ON rp.role = 'mentor' AND rp.feature_key = k.feature_key
 ORDER BY 1;


-- ── ROLLBACK (indien nodig) ─────────────────────────────────────────────────
-- UPDATE public.role_permissions SET allowed = false
--  WHERE role = 'mentor' AND feature_key = 'onboarding.create';
