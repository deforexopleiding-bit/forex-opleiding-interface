-- _datafix-2026-08-22-er-schilderwerken-verlegd.sql
-- ===========================================================================
-- DATA-FIX (GEEN schema-migratie). HANDMATIG draaien in Supabase, MET review.
-- Onderwerp: klant "ER Schilderwerken" — abonnement toont €8.424 i.p.v. €7.200.
--
-- Oorzaak (zie PR-omschrijving): de CRM kent geen "BTW verlegd / medecontractant".
-- De regels staan opgeslagen met de NOMINALE tarieven (€4.800 @21% + €2.400 @9%
-- = €8.424 incl) i.p.v. 0% verlegd (€7.200). Daarnaast staat er een DUBBELE
-- rij: een actieve wizard-rij (teamleader_subscription_id IS NULL) + een
-- import-ghost (imported_from_tl_at IS NOT NULL, status cancelled → "Beëindigd").
--
-- Deze fix doet twee dingen, ALLEEN na jouw review van STAP 0:
--   STAP 1 — zet de regels van de ACTIEVE (niet-geïmporteerde) sub op 0% verlegd
--            → termijnbedrag wordt €7.200.
--   STAP 2 — verwijder de import-ghost-sub + zijn ghost-deal (source='tl_import').
--
-- VEILIG WERKEN:
--   1. Draai eerst STAP 0 en controleer dat je PRECIES 1 actieve + 1 ghost-rij ziet.
--   2. Vul de gevonden id's in bij STAP 1/2 (of gebruik de by-name-variant, maar
--      alleen als STAP 0 exact deze twee rijen toont).
--   3. Draai STAP 1/2 binnen de transactie, controleer STAP 3, dan pas COMMIT.
-- ===========================================================================


-- ── STAP 0 — DIAGNOSE (read-only) ──────────────────────────────────────────
-- Toon alle subs van ER Schilderwerken met de velden die 'actief' vs 'ghost'
-- onderscheiden. Pas de naam-match zo nodig aan (company_name).
SELECT
  c.id            AS customer_id,
  c.company_name,
  s.id            AS subscription_id,
  s.deal_id,
  d.source        AS deal_source,
  s.teamleader_subscription_id,
  s.imported_from_tl_at,
  s.status,
  s.amount,
  s.vat_percentage,
  s.line_items,
  s.created_at
FROM public.subscriptions s
JOIN public.deals     d ON d.id = s.deal_id
JOIN public.customers c ON c.id = d.customer_id
WHERE c.company_name ILIKE '%ER Schilderwerken%'
ORDER BY s.created_at;

-- Verwacht: 2 rijen.
--  • ACTIEF/te-corrigeren:  imported_from_tl_at IS NULL   (wizard-origin)
--  • GHOST/te-verwijderen:  imported_from_tl_at IS NOT NULL, deal_source='tl_import'


-- ── STAP 1 + 2 — CORRECTIE (mutaties, in één transactie) ───────────────────
-- Vul de id's uit STAP 0 in. Laat de transactie open, controleer STAP 3, COMMIT.
BEGIN;

-- STAP 1: regels van de ACTIEVE sub → 0% (BTW verlegd). Zet ook het top-level
-- vat_percentage op 0 zodat het wijzig-scherm 0% toont. jsonb_set per regel.
UPDATE public.subscriptions
SET line_items = COALESCE((
      SELECT jsonb_agg(jsonb_set(elem, '{vat_percentage}', '0'::jsonb, true))
      FROM jsonb_array_elements(line_items) AS elem
    ), line_items),
    vat_percentage = 0,
    updated_at = now()
WHERE id = '<ACTIVE_SUBSCRIPTION_ID>';   -- ← uit STAP 0 (imported_from_tl_at IS NULL)

-- STAP 2: verwijder de import-ghost-sub en zijn ghost-deal.
DELETE FROM public.subscriptions
WHERE id = '<GHOST_SUBSCRIPTION_ID>'      -- ← uit STAP 0 (imported_from_tl_at IS NOT NULL)
  AND imported_from_tl_at IS NOT NULL;    -- extra veiligheidsklem

DELETE FROM public.deals
WHERE id = '<GHOST_DEAL_ID>'              -- ← deal_id van de ghost-sub uit STAP 0
  AND source = 'tl_import'                -- extra veiligheidsklem
  AND NOT EXISTS (SELECT 1 FROM public.subscriptions s2 WHERE s2.deal_id = deals.id);


-- ── STAP 3 — VERIFICATIE (nog binnen de transactie) ────────────────────────
-- Verwacht nu: 1 rij, incl. termijnbedrag = €7.200 (regels op 0%).
SELECT
  s.id, s.status, s.amount, s.vat_percentage, s.line_items,
  (SELECT COALESCE(SUM((e->>'amount')::numeric * (1 + COALESCE((e->>'vat_percentage')::numeric,0)/100)), s.amount)
     FROM jsonb_array_elements(s.line_items) e) AS incl_per_termijn
FROM public.subscriptions s
JOIN public.deals d ON d.id = s.deal_id
JOIN public.customers c ON c.id = d.customer_id
WHERE c.company_name ILIKE '%ER Schilderwerken%'
ORDER BY s.created_at;

-- Klopt alles? → COMMIT;   Niet goed? → ROLLBACK;
-- COMMIT;
-- ROLLBACK;
