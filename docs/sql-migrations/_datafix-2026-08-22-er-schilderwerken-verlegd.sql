-- _datafix-2026-08-22-er-schilderwerken-verlegd.sql
-- ===========================================================================
-- DATA-FIX (GEEN schema-migratie). HANDMATIG draaien in Supabase, MET review.
-- Onderwerp: klant "ER Schilderwerken".
--   (1) DUBBELE abonnement-rij  → dedup (deze fix, STAP 2).
--   (2) Opgeblazen bedrag €8.424 i.p.v. €7.200 (BTW verlegd niet als 0%
--       opgeslagen) → LOS bedrag-fix (STAP 3, optioneel; zie ook PR #1340).
--
-- FEITEN uit de ECHTE query-output (niet uit modelaanname):
--   • Factuur 2026/1547: deal_id = NULL EN tl_subscription_id = NULL → hangt aan
--     niets. GEEN orphan-risico bij welke delete dan ook.
--   • Er zijn TWEE subs, BEIDE met een teamleader_subscription_id:
--       A = ea3c861d…  status cancelled
--       B = b3d2aac0…  status active
--     beide imported_from_tl_at = NULL, ZELFDE deal. Dus GEEN tl_id-NULL-rij en
--     GEEN import-ghost — het zijn twee wizard-aanmaakpogingen, elk met een eigen
--     tl_subscription_id.
--
-- CONCLUSIE:
--   KEEP  = de rij waarvan de tl_subscription_id ÉCHT in Teamleader bestaat
--           (Jeffrey verifieert in TL en levert die id).
--   DELETE= de andere sub-rij (klem op díé specifieke id + tl_id).
--   Geen deal-delete. Geen tl_id-NULL-klem (die matcht hier niets).
--
-- NIETS draait automatisch. Draai STAP 1 eerst, bevestig de KEEP-id, dan STAP 2.
-- ===========================================================================


-- ── STAP 0 — BLAST-RADIUS (read-only) ──────────────────────────────────────
-- Alle abo's waar de APP btw toepast (regel-btw > 0) terwijl de recentste
-- gekoppelde factuur 0 btw heeft (verlegd/CM) — hetzelfde opgeblazen-patroon.
-- (Los van de dedup hieronder; input voor de bredere bedrag-fix.)
WITH sub_calc AS (
  SELECT
    s.id AS subscription_id, s.deal_id, s.teamleader_subscription_id, s.description, s.status,
    COALESCE((SELECT SUM((e->>'amount')::numeric)
              FROM jsonb_array_elements(s.line_items) e), s.amount)                        AS app_excl_per_term,
    COALESCE((SELECT SUM((e->>'amount')::numeric * (1 + COALESCE(NULLIF(e->>'vat_percentage','')::numeric,0)/100))
              FROM jsonb_array_elements(s.line_items) e), s.amount)                         AS app_incl_per_term,
    COALESCE((SELECT MAX(COALESCE(NULLIF(e->>'vat_percentage','')::numeric,0))
              FROM jsonb_array_elements(s.line_items) e), s.vat_percentage)                 AS max_line_vat
  FROM public.subscriptions s
  WHERE s.teamleader_subscription_id IS NOT NULL
),
inv_recent AS (
  SELECT DISTINCT ON (i.tl_subscription_id)
    i.tl_subscription_id, i.vat_amount, i.amount_total, i.status AS invoice_status, i.issue_date, i.invoice_number
  FROM public.invoices i
  WHERE i.tl_subscription_id IS NOT NULL
  ORDER BY i.tl_subscription_id, i.issue_date DESC NULLS LAST, i.created_at DESC
)
SELECT
  COALESCE(NULLIF(c.company_name,''), TRIM(c.first_name || ' ' || c.last_name)) AS klant,
  sc.subscription_id, sc.description, sc.status,
  sc.max_line_vat AS app_max_regel_btw_pct,
  ROUND(sc.app_excl_per_term, 2) AS app_excl_per_termijn,
  ROUND(sc.app_incl_per_term, 2) AS app_incl_per_termijn,
  ir.vat_amount AS factuur_btw, ir.amount_total AS factuur_totaal, ir.invoice_number, ir.issue_date,
  ROUND(sc.app_incl_per_term - sc.app_excl_per_term, 2) AS opgeblazen_met
FROM sub_calc sc
JOIN inv_recent ir      ON ir.tl_subscription_id = sc.teamleader_subscription_id
JOIN public.deals d     ON d.id = sc.deal_id
JOIN public.customers c ON c.id = d.customer_id
WHERE sc.max_line_vat > 0 AND COALESCE(ir.vat_amount, 0) = 0
ORDER BY opgeblazen_met DESC;


-- ── STAP 1 — DIAGNOSE ER Schilderwerken (read-only) ────────────────────────
-- Toont beide subs met hun tl_subscription_id. MATCH elke tl_subscription_id
-- tegen Teamleader: de tl_id die in TL BESTAAT = de KEEP-rij; de andere = DELETE.
SELECT
  c.company_name,
  s.id            AS subscription_id,
  s.status,
  s.teamleader_subscription_id,
  s.imported_from_tl_at,
  s.deal_id,
  s.amount,
  s.vat_percentage,
  s.line_items,
  s.created_at
FROM public.subscriptions s
JOIN public.deals     d ON d.id = s.deal_id
JOIN public.customers c ON c.id = d.customer_id
WHERE c.company_name ILIKE '%ER Schilderwerken%'
ORDER BY s.created_at;

-- Uit jouw output: A = ea3c861d… (cancelled), B = b3d2aac0… (active).
-- TL meldde eerder "Inactief" → waarschijnlijk is A de bestaande TL-sub, maar
-- BEVESTIG dat in Teamleader vóór je STAP 2 draait.


-- ── STAP 2 — DEDUP (mutatie, in transactie) ────────────────────────────────
-- Vul de VOLLEDIGE id's in (de output toont truncated waarden). KEEP = de in TL
-- bestaande rij; DELETE = de andere. Dubbele klem (id + tl_id) zodat je nooit de
-- verkeerde rij raakt. GEEN deal-delete: de gedeelde deal blijft staan.
BEGIN;

DELETE FROM public.subscriptions
WHERE id = '<DELETE_SUBSCRIPTION_ID>'                       -- de te verwijderen sub-rij
  AND teamleader_subscription_id = '<DELETE_TL_ID>'        -- klem: exact deze tl_id
  AND id <> '<KEEP_SUBSCRIPTION_ID>';                      -- kan de KEEP-rij nooit raken

-- Controle binnen de transactie: precies 1 rij moet resteren, met de KEEP-tl_id.
SELECT s.id, s.status, s.teamleader_subscription_id, s.amount
FROM public.subscriptions s
JOIN public.deals d ON d.id = s.deal_id
JOIN public.customers c ON c.id = d.customer_id
WHERE c.company_name ILIKE '%ER Schilderwerken%'
ORDER BY s.created_at;
-- 1 rij met tl_id = KEEP? → COMMIT;   Iets anders? → ROLLBACK;
-- COMMIT;
-- ROLLBACK;


-- ── STAP 3 — BEDRAG-FIX (LOS van de dedup; optioneel in dezelfde sessie) ────
-- Zet de regels van de KEEP-rij op 0% (BTW verlegd) → termijnbedrag €7.200.
-- Staat bewust APART: kan ook via de bredere blast-radius-correctie (STAP 0).
-- Alleen draaien NADAT STAP 2 gecommit is en de KEEP-id bevestigd.
-- BEGIN;
-- UPDATE public.subscriptions
-- SET line_items = COALESCE((
--       SELECT jsonb_agg(jsonb_set(elem, '{vat_percentage}', '0'::jsonb, true))
--       FROM jsonb_array_elements(line_items) AS elem
--     ), line_items),
--     vat_percentage = 0,
--     updated_at = now()
-- WHERE id = '<KEEP_SUBSCRIPTION_ID>';
-- -- Verifieer €7.200:
-- SELECT s.id, s.vat_percentage,
--        (SELECT COALESCE(SUM((e->>'amount')::numeric * (1 + COALESCE((e->>'vat_percentage')::numeric,0)/100)), s.amount)
--           FROM jsonb_array_elements(s.line_items) e) AS incl_per_termijn
-- FROM public.subscriptions s WHERE s.id = '<KEEP_SUBSCRIPTION_ID>';
-- COMMIT;
-- ROLLBACK;
