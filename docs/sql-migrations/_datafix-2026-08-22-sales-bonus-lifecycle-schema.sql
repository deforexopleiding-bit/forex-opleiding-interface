-- _datafix-2026-08-22-sales-bonus-lifecycle-schema.sql
-- ===========================================================================
-- Fase 2 · stap (a) — SALES-bonus lifecycle + clawback: SCHEMA + DE-DUP.
-- MANUAL. Jeffrey draait dit; NIETS automatisch. Diagnose eerst; daarna de
-- muterende blokken één voor één (transacties waar iets gemuteerd wordt).
-- De earn-hook/clawback-CODE mergt pas NADAT deze migratie is toegepast
-- (schrijven van status='voided'/paid_at/… vereist deze kolommen + CHECK).
--
-- Doel:
--   • status-CHECK uitbreiden met 'voided' (clawback-eindstatus).
--   • audit-kolommen voided_at + void_reason.
--   • clawback_pending-marker: zichtbaar finance-signaal wanneer een REEDS
--     UITBETAALDE bonus ge-void wordt (terugvorderen/verrekenen).
--   • bestaande dubbele deal_id-bonussen de-duppen (oudste behouden, rest voiden).
--   • daarna: max één ACTIEVE (niet-voided) bonus per deal afdwingen.
-- ===========================================================================


-- ═══ STAP 0 — DIAGNOSE (read-only) ═════════════════════════════════════════

-- 0.1 Huidige status-verdeling (verwacht: bijna alles 'pending').
SELECT status, COUNT(*) AS n, SUM(amount) AS som_amount
FROM public.bonuses
GROUP BY status
ORDER BY status;

-- 0.2 Dubbele bonussen per deal_id — dit is wat de unieke index straks raakt.
--     Bekijk de statussen/bedragen: de-dup houdt de OUDSTE, voidt de rest.
SELECT
  deal_id,
  COUNT(*)                                   AS n_bonussen,
  ARRAY_AGG(id       ORDER BY created_at, id) AS ids_oud_naar_nieuw,
  ARRAY_AGG(status   ORDER BY created_at, id) AS statussen,
  ARRAY_AGG(amount   ORDER BY created_at, id) AS bedragen,
  ARRAY_AGG(created_at ORDER BY created_at, id) AS aangemaakt
FROM public.bonuses
GROUP BY deal_id
HAVING COUNT(*) > 1
ORDER BY n_bonussen DESC, deal_id;

-- 0.2b POORT A — heeft een dubbele deal ergens een GEVORDERDE bonus
--      (earned/invoiced/paid)? Zo ja, dan mag STAP 3 NIET blind de oudste
--      houden: survivor = meest-gevorderde (tie-break oudste), en elke ge-voide
--      'paid'-rij krijgt clawback_pending=true. Alles pending → STAP 3 zoals nu.
SELECT deal_id,
       ARRAY_AGG(status ORDER BY created_at, id) AS statussen,
       BOOL_OR(status IN ('earned','invoiced','paid')) AS heeft_progressie
FROM public.bonuses
GROUP BY deal_id
HAVING COUNT(*) > 1
ORDER BY heeft_progressie DESC, deal_id;

-- 0.3 POORT B — Naam + definitie van de bestaande status-CHECK (nodig voor STAP 1). Standaard-autoname
--     bij een inline column-CHECK = 'bonuses_status_check'. Wijkt af? → pas de
--     DROP in STAP 1 aan naar de conname die hier verschijnt.
SELECT conname, pg_get_constraintdef(oid) AS definitie
FROM pg_constraint
WHERE conrelid = 'public.bonuses'::regclass AND contype = 'c';


-- ═══ STAP 1 — status-CHECK uitbreiden met 'voided' ═════════════════════════
-- (idempotent via IF EXISTS; naam uit STAP 0.3 bevestigen)
ALTER TABLE public.bonuses DROP CONSTRAINT IF EXISTS bonuses_status_check;
ALTER TABLE public.bonuses ADD CONSTRAINT bonuses_status_check
  CHECK (status IN ('pending','earned','invoiced','paid','under_threshold','voided'));


-- ═══ STAP 2 — audit- + clawback-kolommen ═══════════════════════════════════
-- Keuze clawback-marker: een BOOLEAN clawback_pending (default false) i.p.v. een
-- losse tabel. Reden: het is een per-bonus vlag die finance eenvoudig kan
-- filteren ("toon bonussen met clawback_pending = true") en afvinken. Combineert
-- met de notificatie die de CODE stuurt (stap b). clawback_cleared_at laat
-- finance het signaal 'afgehandeld' zetten ZONDER de status te wijzigen (de
-- bonus blijft 'voided'; alleen het openstaande-terugvorder-signaal dooft).
ALTER TABLE public.bonuses
  ADD COLUMN IF NOT EXISTS voided_at           timestamptz,
  ADD COLUMN IF NOT EXISTS void_reason         text,
  ADD COLUMN IF NOT EXISTS clawback_pending    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS clawback_cleared_at timestamptz;

COMMENT ON COLUMN public.bonuses.clawback_pending IS
  'true = een REEDS UITBETAALDE bonus is ge-void (credit/refund/annulering) → finance '
  'moet terugvorderen/verrekenen met de volgende uitbetaling. Finance zet '
  'clawback_cleared_at zodra verrekend (status blijft ''voided'').';
COMMENT ON COLUMN public.bonuses.void_reason IS
  'Reden van voiden (dedup / creditnota / deal geannuleerd / …). Vrije tekst, audit.';


-- ═══ STAP 3 — DE-DUP (auto-committend, GEEN transactie-wrapper) ════════════
-- PROVISORISCH — geldig ALLEEN als POORT A (0.2b) overal heeft_progressie=false
-- (alle dubbelen nog pending). Toont POORT A ergens true, dan wordt dit blok
-- herschreven (survivor = meest-gevorderde; ge-voide 'paid' → clawback_pending
-- = true) — NIET draaien vóór die herziening.
--
-- WAAROM GEEN BEGIN/COMMIT: de Supabase SQL-editor voert een run in een impliciete
-- transactie uit en ROLT die TERUG als er een open `BEGIN` staat zonder een COMMIT
-- in dezelfde run. Gevolg (bij deal 7c095c55): de voids werden nooit weggeschreven
-- en STAP 4 zag nog 3 actieve rijen. Daarom nu een KALE, auto-committende UPDATE
-- (draait meteen door) + de verificatie als LOS statement erna.
--
-- Houd per deal de OUDSTE bonus (created_at, dan id als tie-break); void de rest
-- als 'voided' met reden. Nog-nooit-uitbetaalde (pending) rijen → clawback_pending
-- blijft FALSE. Geen DELETE: historie blijft.
--
-- FIX C: de dedup-CTE rankt ALLEEN over niet-voided rijen. Zo tellen eerder ge-
-- voide rijen niet mee in de row_number (geen off-by-one) en worden ze nooit
-- opnieuw geraakt — IDEMPOTENT bij een herhaalde run (veilig zonder rollback-net).

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY deal_id ORDER BY created_at ASC, id ASC) AS rn
  FROM public.bonuses
  WHERE status <> 'voided'
)
UPDATE public.bonuses b
SET status      = 'voided',
    voided_at   = now(),
    void_reason = 'dedup: dubbele bonus voor deze deal — oudste behouden'
FROM ranked r
WHERE b.id = r.id
  AND r.rn > 1;            -- alles behalve de oudste NIET-voided per deal

-- VERIFICATIE (los statement, ná de UPDATE): mag GEEN rijen opleveren
-- (geen deal met >1 niet-voided bonus). Wél rijen? → POORT A opnieuw checken /
-- terugkoppelen vóór STAP 4.
SELECT deal_id, COUNT(*) AS niet_voided
FROM public.bonuses
WHERE status <> 'voided'
GROUP BY deal_id
HAVING COUNT(*) > 1;


-- ═══ STAP 4 — max één ACTIEVE bonus per deal (PARTIËLE unieke index) ════════
-- BEWUST partieel (WHERE status <> 'voided') i.p.v. een volle UNIQUE(deal_id):
--   • we HOUDEN voided duplicaten als historie → volle UNIQUE zou breken;
--   • een toekomstige HER-UITGIFTE na een clawback-void moet mogelijk blijven.
-- Deze index dwingt exact af wat we willen: hooguit één niet-voided bonus/deal.
-- Draait pas NADAT de STAP 3-UPDATE is doorgevoerd én de verificatie 0 rijen gaf
-- (anders faalt de index op de nog-bestaande dubbelen — wat meteen een nuttige
-- guard is).
CREATE UNIQUE INDEX IF NOT EXISTS uq_bonuses_deal_active
  ON public.bonuses (deal_id)
  WHERE status <> 'voided';

-- Klaar. Verificatie achteraf (read-only):
-- SELECT status, COUNT(*) FROM public.bonuses GROUP BY status ORDER BY status;
