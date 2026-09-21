-- 2026-09-21 · deals.quotation_customer_note toevoegen.
--
-- ⚠ MOET DRAAIEN VÓÓR de code-merge in de begeleidende PR.
-- Zonder deze kolom faalt elke nieuwe INSERT in `deals` via
-- api/sales-deal-create.js met `column "quotation_customer_note" does not
-- exist` — sales-wizard v2 is dan volledig gebroken (offertes kunnen niet
-- worden aangemaakt).
--
-- CONTEXT
-- ─────────────────────────────────────────────────────────────────────────
-- Nieuw vrij tekstveld dat sales in stap 4 van de sales-wizard invult en
-- dat KLANT-ZICHTBAAR terechtkomt op de Teamleader-offerte-PDF. De inhoud
-- wordt bij pushQuotationToTl in het bestaande `text`-veld op
-- /quotations.create meegestuurd (via buildPaymentSummaryText), samen met
-- de bestaande betaalregeling-samenvatting. Geen aparte TL-call.
--
-- SEMANTIEK
-- ─────────────────────────────────────────────────────────────────────────
-- Klant-zichtbaar. NIET gebruiken voor interne notities — daar is
-- (indien later gewenst) een aparte kolom voor. Zie CLAUDE.md-notitie.
--
-- Alleen invulbaar bij AANMAKEN van de deal. Zodra tl_quotation_id op de
-- deal staat mag geen enkel update-pad deze kolom nog wijzigen (server
-- gooit 403 in dat scenario) — voorkomt dat DB en reeds-verstuurde PDF
-- uit sync raken.
--
-- SCHEMA
-- ─────────────────────────────────────────────────────────────────────────
-- quotation_customer_note text NULL       vrije tekst, geen lengte-check
--                                          in de DB (whitelist in de API
--                                          knipt op 1000 chars). NULL =
--                                          geen extra tekst op de PDF.

ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS quotation_customer_note text NULL;

COMMENT ON COLUMN public.deals.quotation_customer_note IS
  'Klant-zichtbare vrije tekst die op de Teamleader-offerte-PDF verschijnt (via buildPaymentSummaryText → quotationBody.text). Alleen invulbaar bij aanmaken van de deal; server weigert edits zodra tl_quotation_id IS NOT NULL.';

NOTIFY pgrst, 'reload schema';

-- ROLLBACK (alleen als nog geen deals gevuld):
--   ALTER TABLE public.deals DROP COLUMN quotation_customer_note;
--   NOTIFY pgrst, 'reload schema';
