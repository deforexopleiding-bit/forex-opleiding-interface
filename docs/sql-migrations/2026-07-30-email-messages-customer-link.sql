-- 2026-07-30 — email_messages: customer_id koppeling voor unified inbox (fase 4 blok 2)
--
-- ADDITIEF: voegt kolom + index toe, verandert niks weg. Bestaande inserts
-- blijven werken (nullable, geen constraint). Backfill zit hieronder in een
-- APART blok — draai die pas NA de kolom-migratie.
--
-- Volgorde:
--   1. Draai eerst BLOK A (kolom + index).
--   2. Deploy de code (sync-emails.js + email-message-link-customer.js) —
--      nieuwe mails krijgen customer_id bij insert; oude blijven NULL tot
--      backfill.
--   3. Draai daarna BLOK B (backfill) en LEES de counts uit de RAISE NOTICE.
--   4. Corrigeer eventuele NULL-gebleven rijen handmatig via het nieuwe
--      /api/email-message-link-customer endpoint (of via de UI-knop).

-- ═════════════════════════════════════════════════════════════════════
-- BLOK A — kolom + index (idempotent)
-- ═════════════════════════════════════════════════════════════════════

ALTER TABLE public.email_messages
  ADD COLUMN IF NOT EXISTS customer_id uuid NULL
    REFERENCES public.customers(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.email_messages.customer_id IS
  'FK naar customers (nullable). Gezet door sync-emails.js bij insert (match on
   lower(from_address) = lower(customers.email)) of via /api/email-message-link-
   customer voor handmatige correctie. NULL = geen match of ambiguous (>1 hit).';

CREATE INDEX IF NOT EXISTS idx_email_messages_customer_id
  ON public.email_messages (customer_id)
  WHERE customer_id IS NOT NULL;

-- Index voor de match-lookup zelf (case-insensitive on from_address):
CREATE INDEX IF NOT EXISTS idx_email_messages_from_address_lower
  ON public.email_messages (lower(from_address));

-- ═════════════════════════════════════════════════════════════════════
-- BLOK B — backfill (draai APART, LEES de counts)
--
-- Match-regels:
--   • lower(email_messages.from_address) = lower(customers.email)
--   • customer archived_at IS NULL AND anonymized_at IS NULL
--   • ALS EXACT 1 hit → set customer_id
--   • ALS 0 hits      → laat NULL
--   • ALS >1 hits     → laat NULL (ambigu — dupe email bij >1 klant)
--
-- Deze query overschrijft NIET wat al gekoppeld is (WHERE customer_id IS NULL),
-- dus veilig meerdere keren draaien.
-- ═════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_before_null   int;
  v_after_null    int;
  v_updated       int;
  v_dupes         int;
BEGIN
  -- PRE-count: hoeveel email_messages zonder customer_id?
  SELECT count(*) INTO v_before_null
    FROM public.email_messages
    WHERE customer_id IS NULL;

  -- Count ambiguous: hoeveel from_address'en hebben >1 matchende actieve klant?
  SELECT count(*) INTO v_dupes
    FROM (
      SELECT lower(em.from_address) AS addr
        FROM public.email_messages em
        WHERE em.customer_id IS NULL
          AND em.from_address IS NOT NULL
          AND em.from_address <> ''
        GROUP BY lower(em.from_address)
        HAVING (
          SELECT count(*) FROM public.customers c
            WHERE lower(c.email) = lower(em.from_address)
              AND c.archived_at IS NULL
              AND c.anonymized_at IS NULL
        ) > 1
    ) x;

  -- BACKFILL: alleen exacte-1-hit gevallen.
  WITH match AS (
    SELECT em.id AS email_id,
           (SELECT c.id FROM public.customers c
              WHERE lower(c.email) = lower(em.from_address)
                AND c.archived_at IS NULL
                AND c.anonymized_at IS NULL
              LIMIT 2) AS first_cust_id,
           (SELECT count(*) FROM public.customers c
              WHERE lower(c.email) = lower(em.from_address)
                AND c.archived_at IS NULL
                AND c.anonymized_at IS NULL) AS hit_count
      FROM public.email_messages em
      WHERE em.customer_id IS NULL
        AND em.from_address IS NOT NULL
        AND em.from_address <> ''
  )
  UPDATE public.email_messages em
     SET customer_id = m.first_cust_id
    FROM match m
    WHERE em.id = m.email_id
      AND m.hit_count = 1;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  SELECT count(*) INTO v_after_null
    FROM public.email_messages
    WHERE customer_id IS NULL;

  RAISE NOTICE '════════════════════════════════════════';
  RAISE NOTICE 'email_messages customer_id backfill klaar';
  RAISE NOTICE '  Rijen zonder customer_id VOOR:  %', v_before_null;
  RAISE NOTICE '  Rijen NIEUW gekoppeld:          %', v_updated;
  RAISE NOTICE '  Rijen zonder customer_id NA:    %', v_after_null;
  RAISE NOTICE '  From_address ambiguous (>1 hit): %', v_dupes;
  RAISE NOTICE '  → Ambiguous rijen blijven NULL — koppel handmatig via UI.';
  RAISE NOTICE '════════════════════════════════════════';
END $$;
