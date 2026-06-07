-- 2026-06-07-payments-source-camt-match.sql
-- Voeg 'camt_match' en 'camt_match_autopilot' toe aan payments.source CHECK.
--
-- Bug bevestigd op 2026-06-07:
--   POST /api/finance-payment-match-confirm slaagt op TL-zijde (factuur
--   wordt paid in Teamleader), maar de daaropvolgende lokale INSERT in
--   public.payments faalt op:
--     payments_source_check
--   omdat source='camt_match' niet in de toegestane set ('ing','tl','manual')
--   zit. Resultaat: TL is bijgewerkt, onze interne payments-audit-row
--   ontbreekt, en UI toont een fout.
--
--   Autopilot-pad gebruikt 'camt_match_autopilot' — daarvoor geldt hetzelfde.
--
-- Oorspronkelijke constraint (migratie 2026-05-30-finance-fase-1-fundament.sql
-- regel 126):
--   source text CHECK (source IN ('ing','tl','manual'))
--
-- Nieuwe set: behoudt legacy 'ing'/'tl' voor backwards-compat (mogelijk al
-- rijen in productie), voegt twee nieuwe waarden toe voor CAMT-matching.
-- Komt overeen met alle source-strings die de code daadwerkelijk gebruikt:
--   - finance-invoice-register-payment.js → 'manual'
--   - finance-payment-match-confirm.js    → 'camt_match'
--   - finance-bank-camt-upload.js         → 'camt_match_autopilot'
--   - finance-payment-matcher-run.js      → 'camt_match_autopilot'

BEGIN;

ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_source_check;

ALTER TABLE public.payments ADD CONSTRAINT payments_source_check
  CHECK (source IS NULL OR source IN (
    'ing',                    -- legacy
    'tl',                     -- legacy
    'manual',                 -- handmatige boeking via UI
    'camt_match',             -- CAMT-match confirm
    'camt_match_autopilot'    -- CAMT-match autopilot (auto-confirm)
  ));

-- Verificatie: laat de query falen als er bestaande rijen zijn met een
-- source-waarde buiten de nieuwe set. (Mag eigenlijk niet voorkomen want
-- de oude constraint was strenger; safety-net.)
DO $$
DECLARE
  bad_count int;
BEGIN
  SELECT COUNT(*) INTO bad_count
  FROM public.payments
  WHERE source IS NOT NULL
    AND source NOT IN ('ing','tl','manual','camt_match','camt_match_autopilot');
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'payments.source bevat % onverwachte waarde(s) — onderzoek vóór commit', bad_count;
  END IF;
END $$;

COMMIT;
