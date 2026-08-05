-- 2026-08-05 — lisa_followups: atomic claim-lock tegen dubbele processing
--
-- Aanleiding: burst van 7-9 follow-ups binnen 20s naar dezelfde klant. Root cause:
--   1. Nachtelijke backlog wordt bij venster-open in 1 batch (20 items) verwerkt.
--   2. Geen per-item lock → 2 gelijktijdige cron-runs OF een dubbele webhook-trigger
--      kunnen hetzelfde item beide oppakken en 2× versturen.
--   3. Guard A ('user_responded') kijkt naar de LAATSTE lisa_messages.direction.
--      Zodra item 1 van de batch een out-message inserteert, ziet Guard A bij item 2
--      'direction=out' i.p.v. de user's laatste inbound → laat door.
--
-- Fix in deze migratie: nieuwe kolom claimed_at + index. Cron-code doet een
-- atomic UPDATE ... WHERE status='scheduled' AND claimed_at IS NULL, en pakt
-- alleen items op waar die claim lukt. Andere workers/re-entrant runs skippen.
--
-- Expiry-mechanisme: als een claimed item na 5 min nog niet status='sent'/'cancelled'
-- heeft (bv. crash tussen claim en send), reset dan claimed_at → NULL zodat de
-- volgende cron 'em opnieuw kan proberen. Zit in de cron-code, niet in DB-trigger,
-- omdat de reset alleen buiten kantooruren-fout geen zin heeft en de code de
-- expliciete logica beter kan uitdrukken.
--
-- ADDITIEF: 1 kolom + 1 partial index. Geen data-migratie nodig — bestaande rijen
-- krijgen claimed_at=NULL en gedragen zich exact zoals voorheen.

ALTER TABLE lisa_followups
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz NULL;

-- Partial index voor de hot-path: "welke items zijn nog te claimen".
-- Excludeert al-verstuurde/cancelled items én al-geclaimde items uit de index.
CREATE INDEX IF NOT EXISTS idx_lisa_followups_claimable
  ON lisa_followups (scheduled_for)
  WHERE status = 'scheduled' AND claimed_at IS NULL;

COMMENT ON COLUMN lisa_followups.claimed_at IS
  'Set door cron-lisa-delayed vlak vóór send-attempt. Race-free claim: alleen
   1 worker kan claimed_at zetten omdat de UPDATE guard-eq check is. Rows met
   claimed_at ouder dan 5 min zonder status-transitie worden door de cron zelf
   gereset (recovery van crash tussen claim en send).';
