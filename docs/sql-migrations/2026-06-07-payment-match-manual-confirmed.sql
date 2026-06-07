-- 2026-06-07-payment-match-manual-confirmed.sql
-- Voegt 'manual_confirmed' toe aan payment_match_candidates.status CHECK.
--
-- Use-case: gebruiker klikt op een bank-tx waar de automatische matcher geen
-- factuur vond, opent het detail-modal, zoekt een factuur op klantnaam of
-- factuurnummer, en koppelt 'm handmatig. Deze actie maakt een match-record
-- met status='manual_confirmed' i.p.v. 'confirmed' zodat we in audits het
-- verschil zien tussen "auto-matcher voorgesteld + gebruiker bevestigd"
-- (status='confirmed', match_score>=70) en "gebruiker zelf gekoppeld zonder
-- voorstel" (status='manual_confirmed', match_score=100, match_reasons=
-- ['manual_link']).
--
-- Oorspronkelijke constraint (migratie 2026-06-06-payment-match-candidates.sql
-- regel 24): CHECK (status IN ('suggested','confirmed','rejected','auto_confirmed')).
--
-- Idempotent (DROP IF EXISTS).

BEGIN;

ALTER TABLE public.payment_match_candidates
  DROP CONSTRAINT IF EXISTS payment_match_candidates_status_check;

ALTER TABLE public.payment_match_candidates
  ADD CONSTRAINT payment_match_candidates_status_check
  CHECK (status IN (
    'suggested',          -- auto-matcher voorstel (score 70-100)
    'confirmed',          -- suggested + door gebruiker bevestigd
    'auto_confirmed',     -- autopilot bevestigd (score >= threshold)
    'rejected',           -- gebruiker afgewezen
    'manual_confirmed'    -- handmatig gekoppeld vanuit bank-tx modal (geen voorstel)
  ));

-- Safety-net: faal bij bestaande rijen met onverwachte waarde.
DO $$
DECLARE bad_count int;
BEGIN
  SELECT COUNT(*) INTO bad_count
  FROM public.payment_match_candidates
  WHERE status NOT IN ('suggested','confirmed','auto_confirmed','rejected','manual_confirmed');
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'payment_match_candidates.status bevat % onverwachte waarde(s)', bad_count;
  END IF;
END $$;

COMMIT;
