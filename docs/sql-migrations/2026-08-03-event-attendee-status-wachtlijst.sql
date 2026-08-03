-- ============================================================================
-- event_attendee_status: waarde 'wachtlijst' toevoegen
-- ============================================================================
-- Marker voor overflow-aanmeldingen (GHL-inbound bij vol + vragenlijst-afronding
-- bij vol). 'wachtlijst' valt automatisch buiten elke capaciteits-telling, want
-- die eist status IN ('aangemeld','aanwezig').
--
-- DRAAIVOLGORDE (kritisch):
--   1) DIT bestand EERST draaien + verifiëren. Een ALTER TYPE ... ADD VALUE moet
--      in een eigen, gecommitte transactie staan vóór code die de waarde schrijft
--      — anders faalt de insert/update met "unsafe use of new enum value".
--   2) daarna de view-SQL (PR #1060),
--   3) daarna PAS de code-PR mergen (die 'wachtlijst' schrijft).
-- Code die 'wachtlijst' schrijft mag NIET live vóór deze enum bestaat.
-- ============================================================================

ALTER TYPE public.event_attendee_status ADD VALUE IF NOT EXISTS 'wachtlijst';

-- Verificatie: 'wachtlijst' moet in de lijst staan.
SELECT unnest(enum_range(NULL::public.event_attendee_status))::text AS statussen;
