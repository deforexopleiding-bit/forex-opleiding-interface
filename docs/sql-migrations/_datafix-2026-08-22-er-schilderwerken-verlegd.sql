-- _datafix-2026-08-22-er-schilderwerken-verlegd.sql
-- ===========================================================================
-- DATA-FIX (GEEN schema-migratie). HANDMATIG draaien in Supabase, MET review.
-- Onderwerp: klant "ER Schilderwerken" — abonnement toont €8.424 i.p.v. €7.200.
--
-- Oorzaak (zie PR #1340): de CRM kent geen "BTW verlegd / medecontractant".
-- Abonnementsregels staan met de NOMINALE tarieven (€4.800 @21% + €2.400 @9%
-- = €8.424 incl) i.p.v. 0% verlegd (€7.200). Daarnaast staan er TWEE rijen voor
-- deze klant.
--
-- BELANGRIJK (welke rij is TL-autoritatief?):
--   De app koppelt een factuur aan een abo via
--       invoices.tl_subscription_id = subscriptions.teamleader_subscription_id
--   Factuur 2026/1547 draagt een tl_subscription_id — dus alleen de rij MÉT een
--   teamleader_subscription_id (de "Beëindigd"/geïmporteerde rij, die in TL
--   "Inactief" is) kan de factuur-tegenhanger zijn. De wizard-rij (tl_id NULL,
--   "Actief") kan dat NIET zijn.
--   => We CORRIGEREN de TL-GEKOPPELDE rij naar 0% en VERWIJDEREN de tl_id-loze
--      wizard-duplicaat. (Omgekeerd zou factuur 2026/1547 orphanen.)
--   Facturen hebben GEEN foreign key naar subscriptions.id — het verwijderen van
--   een sub-rij verwijdert dus nooit een factuur, maar het verbreekt WEL de
--   logische join als die rij de matchende tl_id droeg. Vandaar deze richting.
--
-- VOLGORDE:
--   STAP 0   — BLAST-RADIUS: hoeveel abo's hebben ditzelfde patroon? (read-only)
--   STAP 1   — VERIFICATIE welke rij TL-autoritatief is (read-only, (a)(b)(c))
--   STAP 2   — CORRECTIE (transactie): TL-rij → 0% + wizard-duplicaat weg
--   STAP 3   — VERIFICATIE (binnen de transactie) → COMMIT of ROLLBACK
--
-- NIETS draait automatisch. Draai STAP 0/1 eerst, review, dan pas STAP 2.
-- ===========================================================================


-- ── STAP 0 — BLAST-RADIUS (read-only) ──────────────────────────────────────
-- Alle abonnementen waar de APP btw toepast (regel-btw > 0) terwijl de
-- gekoppelde, RECENTSTE factuur voor dat abo 0 btw heeft (verlegd/CM). Dat is
-- exact het ER-Schilderwerken-patroon: het app-termijnbedrag is opgeblazen t.o.v.
-- de echte factuur. Join op teamleader_subscription_id = tl_subscription_id.
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
-- Vangt óók tl_id = NULL wizard-rijen: abo's met regel-btw > 0 waarvan de KLANT
-- ≥1 verlegd-factuur (vat_amount = 0) heeft. Kan false positives geven — enkel
-- als attentielijst.
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


-- ── STAP 1 — VERIFICATIE: welke rij is TL-autoritatief? (read-only) ────────

-- 1a) Alle subs van ER Schilderwerken (actief vs ghost onderscheiden).
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

-- 1b) (a) Welke sub-rij draagt de tl_subscription_id van factuur 2026/1547?
--     matched_sub_by_tlid = de KEEP-rij (TL-autoritatief). Zowel deal_id als
--     tl_subscription_id van de factuur worden getoond zodat je beide koppelingen
--     ziet.
SELECT
  i.invoice_number,
  i.tl_invoice_id,
  i.deal_id            AS invoice_deal_id,
  i.tl_subscription_id AS invoice_tl_subscription_id,
  i.vat_amount,
  i.amount_total,
  i.status             AS invoice_status,
  s.id                 AS matched_sub_by_tlid,   -- ← dit is de KEEP-rij
  s.status             AS matched_sub_status,
  s.imported_from_tl_at,
  s.deal_id            AS matched_sub_deal_id
FROM public.invoices i
LEFT JOIN public.subscriptions s
       ON s.teamleader_subscription_id = i.tl_subscription_id
WHERE i.invoice_number = '2026/1547';

-- 1c) (b)+(c) Per sub-rij: hoeveel facturen hangen eraan via tl_id én via deal?
--     De rij met facturen_via_tl_id > 0 is TL-autoritatief (KEEP, NIET verwijderen).
--     De rij met 0/0 is de veilige duplicaat om te verwijderen.
SELECT
  s.id AS subscription_id, s.status, s.teamleader_subscription_id, s.imported_from_tl_at, s.deal_id,
  (SELECT COUNT(*) FROM public.invoices i
     WHERE s.teamleader_subscription_id IS NOT NULL
       AND i.tl_subscription_id = s.teamleader_subscription_id) AS facturen_via_tl_id,
  (SELECT COUNT(*) FROM public.invoices i WHERE i.deal_id = s.deal_id) AS facturen_via_deal
FROM public.subscriptions s
JOIN public.deals d     ON d.id = s.deal_id
JOIN public.customers c ON c.id = d.customer_id
WHERE c.company_name ILIKE '%ER Schilderwerken%'
ORDER BY s.created_at;

-- STOP-conditie: als STAP 1b/1c NIET precies één rij met tl_id + facturen tonen
-- (bijv. beide rijen hebben een tl_id, of geen enkele), draai STAP 2 NIET en meld
-- terug — dan klopt de aanname niet.


-- ── STAP 2 — CORRECTIE (mutaties, in één transactie) ───────────────────────
-- KEEP  = de TL-autoritatieve rij (matched_sub_by_tlid uit 1b / facturen_via_tl_id>0 uit 1c)
-- DELETE= de tl_id-loze wizard-duplicaat (de andere rij; geen facturen)
-- Vul de id's in. Laat de transactie open, controleer STAP 3, dan COMMIT.
BEGIN;

-- STAP 2a: CORRIGEER de TL-gekoppelde (KEEP) rij → regels 0% (BTW verlegd) +
-- top-level vat_percentage 0. De teamleader_subscription_id blijft ONGEWIJZIGD,
-- dus de factuur-koppeling (2026/1547) blijft intact.
UPDATE public.subscriptions
SET line_items = COALESCE((
      SELECT jsonb_agg(jsonb_set(elem, '{vat_percentage}', '0'::jsonb, true))
      FROM jsonb_array_elements(line_items) AS elem
    ), line_items),
    vat_percentage = 0,
    updated_at = now()
WHERE id = '<KEEP_SUBSCRIPTION_ID>'                 -- ← TL-autoritatieve rij (tl_id gezet)
  AND teamleader_subscription_id IS NOT NULL;       -- veiligheidsklem: dit MOET de TL-rij zijn

-- STAP 2b: VERWIJDER de wizard-duplicaat ZONDER TL-koppeling. Veiligheidsklem
-- `teamleader_subscription_id IS NULL` garandeert dat we nooit de factuur-dragende
-- rij raken. De (echte) deal van deze wizard-rij laten we STAAN — dat is de
-- geaccepteerde offerte; enkel de dubbele subscription-rij verdwijnt.
DELETE FROM public.subscriptions
WHERE id = '<DUPLICATE_SUBSCRIPTION_ID>'            -- ← de tl_id-loze wizard-rij
  AND teamleader_subscription_id IS NULL            -- veiligheidsklem: géén TL-link
  AND id <> '<KEEP_SUBSCRIPTION_ID>';               -- kan de KEEP-rij nooit raken

-- ── ALTERNATIEF (NIET standaard — enkel als je de overblijver op de ECHTE deal
-- wilt i.p.v. op de tl_import-ghostdeal): houd de wizard-rij, verplaats de tl_id
-- + status ernaartoe, verwijder daarna de import-rij + ghost-deal. Meer mutatie,
-- zelfde eindbedrag. Overleg eerst — standaard = Optie 1 hierboven.
--   UPDATE public.subscriptions
--     SET teamleader_subscription_id = '<TL_SUB_ID>', status = '<TL_STATUS>', updated_at = now()
--     WHERE id = '<WIZARD_SUBSCRIPTION_ID>';
--   DELETE FROM public.subscriptions WHERE id = '<IMPORT_SUBSCRIPTION_ID>' AND imported_from_tl_at IS NOT NULL;
--   DELETE FROM public.deals WHERE id = '<GHOST_DEAL_ID>' AND source = 'tl_import'
--     AND NOT EXISTS (SELECT 1 FROM public.subscriptions s2 WHERE s2.deal_id = deals.id);


-- ── STAP 3 — VERIFICATIE (nog binnen de transactie) ────────────────────────
-- Verwacht: 1 rij, teamleader_subscription_id GEZET (koppeling intact),
-- incl. termijnbedrag = €7.200 (regels 0%). Plus: factuur 2026/1547 resolvet nog.
SELECT
  s.id, s.status, s.teamleader_subscription_id, s.amount, s.vat_percentage, s.line_items,
  (SELECT COALESCE(SUM((e->>'amount')::numeric * (1 + COALESCE((e->>'vat_percentage')::numeric,0)/100)), s.amount)
     FROM jsonb_array_elements(s.line_items) e)                                  AS incl_per_termijn,
  (SELECT COUNT(*) FROM public.invoices i
     WHERE i.tl_subscription_id = s.teamleader_subscription_id)                  AS gekoppelde_facturen
FROM public.subscriptions s
JOIN public.deals d ON d.id = s.deal_id
JOIN public.customers c ON c.id = d.customer_id
WHERE c.company_name ILIKE '%ER Schilderwerken%'
ORDER BY s.created_at;

-- Controleer expliciet dat 2026/1547 nog aan een subscription hangt:
SELECT i.invoice_number, i.tl_subscription_id,
       EXISTS (SELECT 1 FROM public.subscriptions s
               WHERE s.teamleader_subscription_id = i.tl_subscription_id) AS koppeling_intact
FROM public.invoices i
WHERE i.invoice_number = '2026/1547';

-- Klopt alles (1 rij, tl_id gezet, €7.200, koppeling_intact = true)? → COMMIT;
-- Iets niet goed? → ROLLBACK;
-- COMMIT;
-- ROLLBACK;
