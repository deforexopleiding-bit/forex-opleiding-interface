-- _datafix-2026-08-22-er-schilderwerken-verlegd.sql
-- ===========================================================================
-- DATA-FIX (GEEN schema-migratie). HANDMATIG draaien in Supabase, MET review.
-- Onderwerp: klant "ER Schilderwerken" — abonnement toont €8.424 i.p.v. €7.200.
--
-- Oorzaak (zie PR #1340): de CRM kent geen "BTW verlegd / medecontractant".
-- Abonnementsregels staan met de NOMINALE tarieven (€4.800 @21% + €2.400 @9%
-- = €8.424 incl) i.p.v. 0% verlegd (€7.200). Daarnaast staat er een DUBBELE rij:
-- een actieve wizard-rij (teamleader_subscription_id IS NULL) + een import-ghost
-- (imported_from_tl_at IS NOT NULL, status cancelled → "Beëindigd").
--
-- VOLGORDE:
--   STAP 0  — BLAST-RADIUS: hoe veel abo's hebben ditzelfde patroon? (read-only)
--   STAP 1  — DIAGNOSE ER Schilderwerken (read-only)
--   STAP 2  — CORRECTIE (transactie): regels → 0% verlegd + import-ghost weg
--   STAP 3  — VERIFICATIE (binnen de transactie) → COMMIT of ROLLBACK
--
-- NIETS draait automatisch. Draai STAP 0/1 eerst, review, dan pas STAP 2.
-- ===========================================================================


-- ── STAP 0 — BLAST-RADIUS (read-only) ──────────────────────────────────────
-- Alle abonnementen waar de APP btw toepast (regel-btw > 0) terwijl de
-- gekoppelde, RECENTSTE factuur voor dat abo 0 btw heeft (verlegd/CM). Dat is
-- exact het ER-Schilderwerken-patroon: het app-termijnbedrag is opgeblazen t.o.v.
-- de echte factuur. Join: subscriptions.teamleader_subscription_id =
-- invoices.tl_subscription_id.
--
-- LET OP (blinde vlek): dit vindt alleen abo's MÉT teamleader_subscription_id
-- (die aan een factuur te koppelen zijn). Een wizard-rij met tl_id = NULL (zoals
-- de ACTIEVE ER-Schilderwerken-rij) valt hier buiten — maar zijn geïmporteerde
-- ghost-tweeling (tl_id gezet, óók opgeblazen) verschijnt wél. Zie STAP 0b voor
-- een ruimere, handmatig te beoordelen hint-lijst.
WITH sub_calc AS (
  SELECT
    s.id                          AS subscription_id,
    s.deal_id,
    s.teamleader_subscription_id,
    s.description,
    s.status,
    s.imported_from_tl_at,
    COALESCE((SELECT SUM((e->>'amount')::numeric)
              FROM jsonb_array_elements(s.line_items) e), s.amount)                       AS app_excl_per_term,
    COALESCE((SELECT SUM((e->>'amount')::numeric * (1 + COALESCE(NULLIF(e->>'vat_percentage','')::numeric,0)/100))
              FROM jsonb_array_elements(s.line_items) e), s.amount)                        AS app_incl_per_term,
    COALESCE((SELECT MAX(COALESCE(NULLIF(e->>'vat_percentage','')::numeric,0))
              FROM jsonb_array_elements(s.line_items) e), s.vat_percentage)                AS max_line_vat
  FROM public.subscriptions s
  WHERE s.teamleader_subscription_id IS NOT NULL
),
inv_recent AS (
  SELECT DISTINCT ON (i.tl_subscription_id)
    i.tl_subscription_id, i.vat_amount, i.amount_total, i.status AS invoice_status,
    i.issue_date, i.invoice_number
  FROM public.invoices i
  WHERE i.tl_subscription_id IS NOT NULL
  ORDER BY i.tl_subscription_id, i.issue_date DESC NULLS LAST, i.created_at DESC
)
SELECT
  COALESCE(NULLIF(c.company_name,''), TRIM(c.first_name || ' ' || c.last_name)) AS klant,
  sc.subscription_id,
  sc.description,
  sc.status,
  sc.max_line_vat                              AS app_max_regel_btw_pct,
  ROUND(sc.app_excl_per_term, 2)               AS app_excl_per_termijn,
  ROUND(sc.app_incl_per_term, 2)               AS app_incl_per_termijn,
  ir.vat_amount                                AS factuur_btw,
  ir.amount_total                              AS factuur_totaal,
  ir.invoice_number,
  ir.issue_date,
  ROUND(sc.app_incl_per_term - sc.app_excl_per_term, 2) AS opgeblazen_met
FROM sub_calc sc
JOIN inv_recent ir      ON ir.tl_subscription_id = sc.teamleader_subscription_id
JOIN public.deals d     ON d.id = sc.deal_id
JOIN public.customers c ON c.id = d.customer_id
WHERE sc.max_line_vat > 0            -- app past btw toe op ≥1 regel
  AND COALESCE(ir.vat_amount, 0) = 0 -- echte factuur = verlegd (0 btw)
ORDER BY opgeblazen_met DESC;


-- ── STAP 0b — RUIMERE HINT (read-only, handmatig beoordelen) ────────────────
-- Vangt óók de tl_id = NULL wizard-rijen: abo's met regel-btw > 0 waarvan de
-- KLANT minstens één verlegd-factuur (vat_amount = 0) heeft. Kan false positives
-- geven (klant met zowel verlegde als normale facturen) — dus enkel als
-- attentielijst, niet als waarheid.
SELECT
  COALESCE(NULLIF(c.company_name,''), TRIM(c.first_name || ' ' || c.last_name)) AS klant,
  s.id AS subscription_id, s.description, s.status,
  s.teamleader_subscription_id IS NULL AS geen_tl_koppeling,
  COALESCE((SELECT MAX(COALESCE(NULLIF(e->>'vat_percentage','')::numeric,0))
            FROM jsonb_array_elements(s.line_items) e), s.vat_percentage) AS app_max_regel_btw_pct,
  ROUND(COALESCE((SELECT SUM((e->>'amount')::numeric * (1 + COALESCE(NULLIF(e->>'vat_percentage','')::numeric,0)/100))
            FROM jsonb_array_elements(s.line_items) e), s.amount), 2)     AS app_incl_per_termijn
FROM public.subscriptions s
JOIN public.deals d     ON d.id = s.deal_id
JOIN public.customers c ON c.id = d.customer_id
WHERE COALESCE((SELECT MAX(COALESCE(NULLIF(e->>'vat_percentage','')::numeric,0))
                FROM jsonb_array_elements(s.line_items) e), s.vat_percentage) > 0
  AND EXISTS (
        SELECT 1 FROM public.invoices i
        WHERE i.customer_id = c.id AND COALESCE(i.vat_amount, 0) = 0
      )
ORDER BY klant;


-- ── STAP 1 — DIAGNOSE ER Schilderwerken (read-only) ────────────────────────
-- Toon alle subs van deze klant met de velden die 'actief' vs 'ghost'
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


-- ── STAP 2 — CORRECTIE (mutaties, in één transactie) ───────────────────────
-- Vul de id's uit STAP 1 in. Laat de transactie open, controleer STAP 3, COMMIT.
BEGIN;

-- STAP 2a: regels van de ACTIEVE sub → 0% (BTW verlegd). Zet ook het top-level
-- vat_percentage op 0 zodat het wijzig-scherm 0% toont. jsonb_set per regel.
UPDATE public.subscriptions
SET line_items = COALESCE((
      SELECT jsonb_agg(jsonb_set(elem, '{vat_percentage}', '0'::jsonb, true))
      FROM jsonb_array_elements(line_items) AS elem
    ), line_items),
    vat_percentage = 0,
    updated_at = now()
WHERE id = '<ACTIVE_SUBSCRIPTION_ID>';   -- ← uit STAP 1 (imported_from_tl_at IS NULL)

-- STAP 2b: verwijder de import-ghost-sub en zijn ghost-deal.
DELETE FROM public.subscriptions
WHERE id = '<GHOST_SUBSCRIPTION_ID>'      -- ← uit STAP 1 (imported_from_tl_at IS NOT NULL)
  AND imported_from_tl_at IS NOT NULL;    -- extra veiligheidsklem

DELETE FROM public.deals
WHERE id = '<GHOST_DEAL_ID>'              -- ← deal_id van de ghost-sub uit STAP 1
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
