-- _datafix-2026-08-23-sales-bonus-reconcile.sql
-- ===========================================================================
-- Fase 2 · stap (c) — RECONCILE bestaande 'pending' sales-bonussen.
-- MANUAL. Jeffrey draait; report-first. NU alleen STAP 0 (read-only DIAGNOSE).
-- De muterende STAP 1/2 volgen PAS na review van de STAP 0-output (en worden
-- KAAL auto-committend geleverd — geen BEGIN zonder same-run COMMIT; de Supabase-
-- editor rolt zo'n open transactie terug).
--
-- Reconcile-regels (spiegelen de JS-helper isDownPaymentInvoice-identiteit):
--   • aanbetalingsfactuur van de deal is 'paid'      → bonus zou 'earned' moeten zijn
--   • aanbetalingsfactuur is 'credited'              → bonus zou 'voided' moeten zijn
--   • aanbetaling nog niet betaald                   → laten staan (pending)
-- "Aanbetalingsfactuur" = precies (aanbetalings-sub term_count=1 → factuur via
--   tl_subscription_id) met fallback = vroegste NIET-fee factuur van de deal
--   (gekoppeld via invoices.deal_id OF via de subs' tl_subscription_id's).
--
-- CAVEAT (deal verloren): de deal.lost-webhook zet GEEN persistente 'lost'-vlag
-- op deals — historische deal-loss is dus niet betrouwbaar uit de DB af te leiden.
-- tl_quotation_status wordt puur INFORMATIEF meegetoond; we voiden in STAP 1/2
-- NIET blind op status. Going-forward vangt de webhook deal.lost dit al af.
-- ===========================================================================


-- ═══ STAP 0.1 — SAMENVATTING: hoeveel pending, welke actie ═════════════════
WITH pend AS (
  SELECT b.id AS bonus_id, b.deal_id, b.sales_user_id, b.amount
  FROM public.bonuses b WHERE b.status = 'pending'
),
downsub AS (   -- aanbetalings-sub per deal: eerste term_count=1 (oudste)
  SELECT DISTINCT ON (s.deal_id) s.deal_id, s.teamleader_subscription_id AS down_tl_sub
  FROM public.subscriptions s
  WHERE s.term_count = 1 AND s.deal_id IN (SELECT deal_id FROM pend)
  ORDER BY s.deal_id, s.created_at ASC, s.id ASC
),
dealsub_ids AS (   -- alle tl_sub_ids per deal (fallback-linkage)
  SELECT s.deal_id,
         ARRAY_AGG(s.teamleader_subscription_id) FILTER (WHERE s.teamleader_subscription_id IS NOT NULL) AS tl_ids
  FROM public.subscriptions s
  WHERE s.deal_id IN (SELECT deal_id FROM pend)
  GROUP BY s.deal_id
),
cand AS (   -- kandidaat-facturen per deal (via deal_id OF subs' tl_ids), excl fee
  SELECT p.deal_id, i.id AS invoice_id, i.status AS inv_status,
         i.issue_date, i.created_at, i.tl_subscription_id
  FROM pend p
  JOIN public.deals d ON d.id = p.deal_id
  JOIN public.invoices i
    ON ( i.deal_id = p.deal_id
         OR i.tl_subscription_id = ANY (COALESCE(
              (SELECT tl_ids FROM dealsub_ids ds WHERE ds.deal_id = p.deal_id), ARRAY[]::text[])) )
   AND (d.reservation_fee_invoice_id IS NULL OR i.id::text <> d.reservation_fee_invoice_id)
),
aanbetaling AS (   -- de aanbetalingsfactuur: precies, anders vroegste niet-fee
  SELECT p.bonus_id, p.deal_id,
    COALESCE(
      (SELECT c.invoice_id FROM cand c JOIN downsub ds ON ds.deal_id = p.deal_id
         WHERE ds.down_tl_sub IS NOT NULL AND c.tl_subscription_id = ds.down_tl_sub
         ORDER BY c.issue_date ASC NULLS LAST, c.created_at ASC LIMIT 1),
      (SELECT c.invoice_id FROM cand c WHERE c.deal_id = p.deal_id
         ORDER BY c.issue_date ASC NULLS LAST, c.created_at ASC LIMIT 1)
    ) AS aanbetaling_invoice_id
  FROM pend p
),
classified AS (
  SELECT p.bonus_id, p.amount, ai.status AS aanbetaling_status,
    CASE
      WHEN ai.status = 'credited' THEN 'void (aanbetaling gecrediteerd)'
      WHEN ai.status = 'paid'     THEN 'earn (aanbetaling betaald)'
      ELSE 'leave (aanbetaling nog niet betaald / onbekend)'
    END AS suggested_action
  FROM pend p
  LEFT JOIN aanbetaling a ON a.bonus_id = p.bonus_id
  LEFT JOIN public.invoices ai ON ai.id = a.aanbetaling_invoice_id
)
SELECT suggested_action, COUNT(*) AS n, SUM(amount) AS som_amount
FROM classified
GROUP BY suggested_action
ORDER BY suggested_action;


-- ═══ STAP 0.2 — STEEKPROEF: per pending bonus de details (max 50) ══════════
WITH pend AS (
  SELECT b.id AS bonus_id, b.deal_id, b.sales_user_id, b.amount
  FROM public.bonuses b WHERE b.status = 'pending'
),
downsub AS (
  SELECT DISTINCT ON (s.deal_id) s.deal_id, s.teamleader_subscription_id AS down_tl_sub
  FROM public.subscriptions s
  WHERE s.term_count = 1 AND s.deal_id IN (SELECT deal_id FROM pend)
  ORDER BY s.deal_id, s.created_at ASC, s.id ASC
),
dealsub_ids AS (
  SELECT s.deal_id,
         ARRAY_AGG(s.teamleader_subscription_id) FILTER (WHERE s.teamleader_subscription_id IS NOT NULL) AS tl_ids
  FROM public.subscriptions s
  WHERE s.deal_id IN (SELECT deal_id FROM pend)
  GROUP BY s.deal_id
),
cand AS (
  SELECT p.deal_id, i.id AS invoice_id, i.status AS inv_status,
         i.issue_date, i.created_at, i.tl_subscription_id
  FROM pend p
  JOIN public.deals d ON d.id = p.deal_id
  JOIN public.invoices i
    ON ( i.deal_id = p.deal_id
         OR i.tl_subscription_id = ANY (COALESCE(
              (SELECT tl_ids FROM dealsub_ids ds WHERE ds.deal_id = p.deal_id), ARRAY[]::text[])) )
   AND (d.reservation_fee_invoice_id IS NULL OR i.id::text <> d.reservation_fee_invoice_id)
),
aanbetaling AS (
  SELECT p.bonus_id, p.deal_id,
    COALESCE(
      (SELECT c.invoice_id FROM cand c JOIN downsub ds ON ds.deal_id = p.deal_id
         WHERE ds.down_tl_sub IS NOT NULL AND c.tl_subscription_id = ds.down_tl_sub
         ORDER BY c.issue_date ASC NULLS LAST, c.created_at ASC LIMIT 1),
      (SELECT c.invoice_id FROM cand c WHERE c.deal_id = p.deal_id
         ORDER BY c.issue_date ASC NULLS LAST, c.created_at ASC LIMIT 1)
    ) AS aanbetaling_invoice_id
  FROM pend p
)
SELECT
  p.bonus_id, p.deal_id, p.amount,
  d.tl_quotation_status                 AS deal_status_INFO,   -- puur informatief (zie caveat)
  a.aanbetaling_invoice_id,
  ai.invoice_number                     AS aanbetaling_nr,
  ai.status                             AS aanbetaling_status,
  CASE
    WHEN ai.status = 'credited' THEN 'void (aanbetaling gecrediteerd)'
    WHEN ai.status = 'paid'     THEN 'earn (aanbetaling betaald)'
    ELSE 'leave (aanbetaling nog niet betaald / onbekend)'
  END                                   AS suggested_action
FROM pend p
JOIN public.deals d ON d.id = p.deal_id
LEFT JOIN aanbetaling a ON a.bonus_id = p.bonus_id
LEFT JOIN public.invoices ai ON ai.id = a.aanbetaling_invoice_id
ORDER BY suggested_action, p.amount DESC
LIMIT 50;


-- ═══ STAP 1/2 — MUTATIES (KAAL auto-committend; PAS draaien na STAP 0-review) ═
-- Vul <EARN_BONUS_IDS> en <VOID_BONUS_IDS> met EXACT de bonus_id's uit STAP 0.2:
--   earn-groep = rijen met suggested_action = 'earn (aanbetaling betaald)'
--   void-groep = rijen met suggested_action = 'void (aanbetaling gecrediteerd)'
-- GEEN kale her-earn van alles. Deal-lost NIET meenemen (informatief).
-- Formaat id-lijst: 'uuid1','uuid2','uuid3'  (comma-gescheiden, gequote).
-- Geen BEGIN/COMMIT: kale statements (Supabase-editor rolt een open transactie terug).

-- ─── STAP 1 — EARN (aanbetaling betaald → 'earned') ───────────────────────
-- 1a) Verificatie VOOR (moeten allemaal 'pending' zijn):
SELECT id, status, deal_id, amount FROM public.bonuses
WHERE id IN (<EARN_BONUS_IDS>) ORDER BY id;

-- 1b) Mutatie (idempotent: alleen vanuit pending):
UPDATE public.bonuses
SET status = 'earned', earned_at = now()
WHERE id IN (<EARN_BONUS_IDS>) AND status = 'pending';

-- 1c) Verificatie NA (alles nu 'earned' met earned_at gezet):
SELECT id, status, earned_at FROM public.bonuses
WHERE id IN (<EARN_BONUS_IDS>) ORDER BY id;


-- ─── STAP 2 — VOID (aanbetaling gecrediteerd → 'voided') ──────────────────
-- Deze bonussen zijn 'pending' → NOOIT uitbetaald → GEEN clawback_pending
-- (die vlag is puur voor het voiden van een reeds 'paid' bonus).
-- 2a) Verificatie VOOR (moeten allemaal 'pending' zijn):
SELECT id, status, deal_id, amount FROM public.bonuses
WHERE id IN (<VOID_BONUS_IDS>) ORDER BY id;

-- 2b) Mutatie (idempotent: alleen niet-voided):
UPDATE public.bonuses
SET status = 'voided', voided_at = now(),
    void_reason = 'reconcile: aanbetaling gecrediteerd'
WHERE id IN (<VOID_BONUS_IDS>) AND status <> 'voided';

-- 2c) Verificatie NA:
SELECT id, status, voided_at, void_reason FROM public.bonuses
WHERE id IN (<VOID_BONUS_IDS>) ORDER BY id;
