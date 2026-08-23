-- _datafix-2026-08-23-subscriptions-dedup-index.sql
-- ===========================================================================
-- Dubbele-subscription-PREVENTIE: partiële unieke index als DB-backstop achter
-- de server-side idempotentie-guard (sales-subscription-create.js:1b).
-- MANUAL. Jeffrey draait; DIAGNOSE eerst. GEEN BEGIN/COMMIT rond losse statements
-- (Supabase-editor rolt een open transactie terug).
--
-- VOORWAARDE: de index kan pas AANgemaakt worden als er GEEN niet-cancelled
-- duplicaten meer bestaan. Dus eerst de bekende opschoning draaien (deal
-- 7c095c55: dubbele sub 0fa5e857/TL 3be51ad1 deactiveren+cancellen). STAP 0
-- toont of er nog blokkerende collisions zijn.
--
-- Voorgestelde sleutel: (deal_id, term_count, amount, start_date) WHERE
-- status <> 'cancelled'. STAP 0 verifieert tegen de DATA of die set geen
-- LEGITIEME subs blokkeert (zelfde deal/term/amount/start maar bewust anders,
-- bv. andere description/line_items).
-- ===========================================================================


-- ═══ STAP 0 — DIAGNOSE (read-only): botsingen onder de voorgestelde sleutel ══
-- Elke groep met n>1 zou de unieke index blokkeren. Bekijk `descriptions`:
--   • allemaal identiek  → echte duplicaten → opschonen (cancel de extra's).
--   • bewust verschillend → LEGITIEME collision → sleutel uitbreiden met
--     description (zie de alternatieve index onder STAP 1).
SELECT
  deal_id, term_count, amount, start_date,
  COUNT(*)                       AS n,
  ARRAY_AGG(id           ORDER BY created_at) AS sub_ids,
  ARRAY_AGG(status       ORDER BY created_at) AS statuses,
  ARRAY_AGG(description   ORDER BY created_at) AS descriptions,
  ARRAY_AGG(teamleader_subscription_id ORDER BY created_at) AS tl_sub_ids
FROM public.subscriptions
WHERE status <> 'cancelled'
GROUP BY deal_id, term_count, amount, start_date
HAVING COUNT(*) > 1
ORDER BY n DESC, deal_id;

-- STAP 0b — attentie: subs met start_date IS NULL. Een unieke index behandelt
-- NULLs als DISTINCT, dus die worden NIET door de index gededupt. De server-guard
-- (per-deal) vangt die wél. Puur ter info hoeveel dat er zijn.
SELECT COUNT(*) AS niet_cancelled_zonder_startdate
FROM public.subscriptions
WHERE status <> 'cancelled' AND start_date IS NULL;


-- ═══ STAP 1 — PARTIËLE UNIEKE INDEX (pas draaien na 0 collisions in STAP 0) ══
-- Backstop: hooguit één NIET-cancelled sub per (deal, termijn, bedrag, startdatum).
-- Cancelled rijen blijven als historie toegestaan (partieel).
CREATE UNIQUE INDEX IF NOT EXISTS uq_subscriptions_dedup_active
  ON public.subscriptions (deal_id, term_count, amount, start_date)
  WHERE status <> 'cancelled';

-- ── ALTERNATIEF (alleen als STAP 0 legitieme collisions toont met verschillende
--    description): neem description mee in de sleutel i.p.v. de index hierboven.
-- CREATE UNIQUE INDEX IF NOT EXISTS uq_subscriptions_dedup_active
--   ON public.subscriptions (deal_id, term_count, amount, start_date, description)
--   WHERE status <> 'cancelled';

-- Verificatie achteraf:
-- SELECT indexname, indexdef FROM pg_indexes
-- WHERE tablename = 'subscriptions' AND indexname = 'uq_subscriptions_dedup_active';
