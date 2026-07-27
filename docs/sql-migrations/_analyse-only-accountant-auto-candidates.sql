-- ============================================================================
-- ANALYSE-ONLY (GEEN MIGRATIE — puur SELECT, wijzigt niks)
-- Datum: 2026-07-27
--
-- Doel: vind kandidaat-tegenpartijen voor de 2 nieuwe categorieën
-- 'Accountant & administratie' en 'Auto'. Jeffrey bekijkt de output en
-- wijst er via de UI (categorie-picker per tegenpartij) de juiste toe.
-- Automatisch koppelen op keyword is te gevaarlijk voor financiële data.
-- ============================================================================

-- ── 1) Kandidaten voor 'Accountant & administratie' ──
-- Zoek op: accountant / administratie / boekhoud / fiscaal / kvk / notaris.
-- Toont per counterparty: aantal tx + som + eerste/laatste datum.
SELECT
  counterparty_name,
  COUNT(*)                              AS aantal_tx,
  SUM(amount_cents) / 100.0             AS totaal_eur,
  MIN(booking_date)                     AS eerste,
  MAX(booking_date)                     AS laatste
FROM public.camt_transactions
WHERE amount_cents < 0                  -- alleen uitgaven
  AND (
       counterparty_name ILIKE '%accountant%'
    OR counterparty_name ILIKE '%administratie%'
    OR counterparty_name ILIKE '%boekhoud%'
    OR counterparty_name ILIKE '%fiscaal%'
    OR counterparty_name ILIKE '%fisca%'
    OR counterparty_name ILIKE '%kvk%'
    OR counterparty_name ILIKE '%notaris%'
    OR counterparty_name ILIKE '%rogier%'   -- externe boekhouder uit CLAUDE.md
  )
GROUP BY counterparty_name
ORDER BY totaal_eur ASC;                -- meest-negatief eerst

-- ── 2) Kandidaten voor 'Auto' ──
-- Brandstof / lease / parkeren / verkeer / weg.
SELECT
  counterparty_name,
  COUNT(*)                              AS aantal_tx,
  SUM(amount_cents) / 100.0             AS totaal_eur,
  MIN(booking_date)                     AS eerste,
  MAX(booking_date)                     AS laatste
FROM public.camt_transactions
WHERE amount_cents < 0
  AND (
       counterparty_name ILIKE '%shell%'
    OR counterparty_name ILIKE '%bp%'          -- LET OP: matcht ook 'BP', check output
    OR counterparty_name ILIKE '%esso%'
    OR counterparty_name ILIKE '%tinq%'
    OR counterparty_name ILIKE '%tamoil%'
    OR counterparty_name ILIKE '%tank%'
    OR counterparty_name ILIKE '%brandstof%'
    OR counterparty_name ILIKE '%diesel%'
    OR counterparty_name ILIKE '%benzine%'
    OR counterparty_name ILIKE '%park%'        -- q-park, parkeergarage, etc
    OR counterparty_name ILIKE '%parkmobile%'
    OR counterparty_name ILIKE '%yellowbrick%'
    OR counterparty_name ILIKE '%anwb%'
    OR counterparty_name ILIKE '%bovag%'
    OR counterparty_name ILIKE '%garage%'
    OR counterparty_name ILIKE '%leasing%'
    OR counterparty_name ILIKE '%lease%'
    OR counterparty_name ILIKE '%wegenbelasting%'
    OR counterparty_name ILIKE '%rdw%'
    OR counterparty_name ILIKE '%carwash%'
    OR counterparty_name ILIKE '%allsecur%'    -- auto-verzekeraars
    OR counterparty_name ILIKE '%centraal beheer%'
  )
GROUP BY counterparty_name
ORDER BY totaal_eur ASC;

-- ── 3) BONUS: hulpvraag voor Jeffrey ──
-- Als je een specifieke naam mist, run deze losse query om te zoeken:
-- SELECT counterparty_name, COUNT(*), SUM(amount_cents)/100.0
-- FROM public.camt_transactions
-- WHERE counterparty_name ILIKE '%JOUW_ZOEKTERM%'
-- GROUP BY counterparty_name;
