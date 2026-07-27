-- ============================================================================
-- PayPal description-backfill — betere omschrijving uit raw_xml
-- Datum: 2026-07-27
-- Branch: fix/paypal-description
--
-- Wat: overschrijft description op bestaande camt_transactions-rijen met
-- source='paypal' via de nieuwe cascade (Onderwerp > Item Title > Factuur >
-- Note > Type). raw_xml bevat de hele CSV-rij als JSON — daar leest de query
-- de velden uit via ::jsonb->>.
--
-- Waarom: PR 1a's parser mapte description naar '[Type] counterparty' — dat is
-- te mager (bv. "[Algemene PayPal-bankpastransactie] Meta Platforms, Inc."
-- vertelt niet WAT je bij Meta hebt gekocht). Het echte "Ads"-signaal zit in
-- de Onderwerp-kolom en werd niet gebruikt. Deze backfill zet 'em recht.
--
-- CAMT-rijen (source='camt') worden NIET geraakt — die hebben eigen
-- description uit CAMT.053-XML.
--
-- Idempotent: elke keer draaien geeft hetzelfde resultaat. Veilig te
-- herhalen. Cascade-logica loopt puur op raw_xml — niet op de huidige
-- description-waarde, dus geen risico op cascading errors bij re-run.
--
-- Kolommen die geraakt worden: 1 (description). Alle andere kolommen
-- (amount_cents / booking_date / counterparty_name / raw_xml / source / etc)
-- ongemoeid.
-- ============================================================================

BEGIN;

-- Snelle sanity-check: hoeveel rijen komen er in aanmerking?
DO $$
DECLARE
  paypal_count INT;
  camt_count   INT;
BEGIN
  SELECT COUNT(*) INTO paypal_count
    FROM public.camt_transactions
    WHERE source = 'paypal' AND raw_xml IS NOT NULL AND raw_xml != '';
  SELECT COUNT(*) INTO camt_count
    FROM public.camt_transactions WHERE source = 'camt';
  RAISE NOTICE 'PayPal rijen om te backfillen: %', paypal_count;
  RAISE NOTICE 'CAMT rijen (ONGEMOEID): %', camt_count;
END$$;

-- ── De backfill zelf: cascade via COALESCE + NULLIF(TRIM(...), '') ──
-- Volgorde: Onderwerp > Item Title > Factuur (met "Factuur "-prefix) > Note > Type.
-- Als raw_xml niet parseable is, blijft description ongewijzigd (WHERE-filter
-- vangt dat af via de try_cast pattern).

UPDATE public.camt_transactions
SET description = COALESCE(
  NULLIF(TRIM((raw_xml::jsonb ->> 'Onderwerp')), ''),
  NULLIF(TRIM((raw_xml::jsonb ->> 'Item Title')), ''),
  CASE
    WHEN NULLIF(TRIM((raw_xml::jsonb ->> 'Factuurnummer')), '') IS NOT NULL
      THEN 'Factuur ' || TRIM((raw_xml::jsonb ->> 'Factuurnummer'))
    ELSE NULL
  END,
  NULLIF(TRIM((raw_xml::jsonb ->> 'Note')), ''),
  NULLIF(TRIM((raw_xml::jsonb ->> 'Type')), ''),
  description   -- fail-safe: raw_xml is er wel maar alle velden leeg → laat oude description
)
WHERE source = 'paypal'
  AND raw_xml IS NOT NULL
  AND raw_xml != ''
  -- Alleen updaten als de nieuwe waarde ECHT anders is, zodat idempotent-runs
  -- niet elke keer alle rijen touchen (spaart WAL + updated_at-triggers).
  AND description IS DISTINCT FROM COALESCE(
    NULLIF(TRIM((raw_xml::jsonb ->> 'Onderwerp')), ''),
    NULLIF(TRIM((raw_xml::jsonb ->> 'Item Title')), ''),
    CASE
      WHEN NULLIF(TRIM((raw_xml::jsonb ->> 'Factuurnummer')), '') IS NOT NULL
        THEN 'Factuur ' || TRIM((raw_xml::jsonb ->> 'Factuurnummer'))
      ELSE NULL
    END,
    NULLIF(TRIM((raw_xml::jsonb ->> 'Note')), ''),
    NULLIF(TRIM((raw_xml::jsonb ->> 'Type')), ''),
    description
  );

-- Post-check: hoeveel PayPal-rijen hebben nu een niet-lege description?
DO $$
DECLARE
  filled INT;
  total  INT;
BEGIN
  SELECT COUNT(*) INTO filled
    FROM public.camt_transactions
    WHERE source = 'paypal' AND description IS NOT NULL AND description != '';
  SELECT COUNT(*) INTO total
    FROM public.camt_transactions WHERE source = 'paypal';
  RAISE NOTICE 'PayPal rijen met description gevuld na backfill: % / %', filled, total;
END$$;

COMMIT;

-- ROLLBACK (indien nodig — zet description terug naar oude cascade '[Type] Naam'):
-- UPDATE public.camt_transactions
-- SET description = '[' || TRIM((raw_xml::jsonb ->> 'Type')) || '] ' || counterparty_name
-- WHERE source = 'paypal' AND raw_xml IS NOT NULL AND raw_xml != '';
