-- 2026-08-24 · event_signup_inbox dedup op ghl_form_submission_id + UNIQUE-index.
--
-- CONTEXT
-- events-signup-inbound.js deed dedup op (event_id, email) OF phone, maar NIET
-- op ghl_form_submission_id. Gevolg:
--   • Zelfde persoon 2× hetzelfde formulier → 2 inbox-rijen.
--   • Cross-event dubbelen mogelijk (nu buiten scope; client-side gegroepeerd).
--
-- WAT DEZE MIGRATIE DOET
-- Stap 0 (RAISE NOTICE): rapporteer counts vóór mutatie zodat Jeffrey ziet
--                        wat er verwijderd gaat worden.
-- Stap 1 : dedup bestaande rijen met dezelfde non-null ghl_form_submission_id
--          (behoud de rij met de HOOGSTE received_at; bij gelijk: MAX(id)).
-- Stap 2 : UNIQUE partial index op event_signup_inbox (ghl_form_submission_id)
--          WHERE ghl_form_submission_id IS NOT NULL. Voorkomt toekomstige
--          duplicaten.
-- Alles in 1 transactie zodat een fout in stap 2 stap 1 rollback't.
--
-- WAT DEZE MIGRATIE NIET DOET
--   • NULL-ghl_form_submission_id-rijen worden NIET aangeraakt (partial index
--     vangt ze niet af; hun dedup blijft (event_id, email/phone)-based).
--   • Client-side cross-event groepering leeft in events-v2.js (aparte edit).
--
-- ROLLBACK
--   BEGIN;
--   DROP INDEX IF EXISTS event_signup_inbox_ghl_form_submission_id_uidx;
--   -- Data-restore uit oude backup indien nodig; dedup is one-way.
--   COMMIT;

BEGIN;

-- ═══ STAP 0 · MEET DE BESTAANDE STAAT ═══════════════════════════════════════
DO $$
DECLARE
  v_total       BIGINT;
  v_nn_ghl      BIGINT;
  v_null_ghl    BIGINT;
  v_dup_groups  BIGINT;
  v_dup_rows    BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_total    FROM public.event_signup_inbox;
  SELECT COUNT(*) INTO v_nn_ghl   FROM public.event_signup_inbox WHERE ghl_form_submission_id IS NOT NULL;
  SELECT COUNT(*) INTO v_null_ghl FROM public.event_signup_inbox WHERE ghl_form_submission_id IS NULL;

  SELECT COUNT(*) INTO v_dup_groups FROM (
    SELECT ghl_form_submission_id
    FROM public.event_signup_inbox
    WHERE ghl_form_submission_id IS NOT NULL
    GROUP BY ghl_form_submission_id
    HAVING COUNT(*) > 1
  ) t;

  SELECT COALESCE(SUM(cnt - 1), 0) INTO v_dup_rows FROM (
    SELECT ghl_form_submission_id, COUNT(*) AS cnt
    FROM public.event_signup_inbox
    WHERE ghl_form_submission_id IS NOT NULL
    GROUP BY ghl_form_submission_id
    HAVING COUNT(*) > 1
  ) t;

  RAISE NOTICE '── event_signup_inbox PRE-DEDUP ─────────────────────';
  RAISE NOTICE '  totaal rijen                          : %', v_total;
  RAISE NOTICE '  met non-null ghl_form_submission_id   : %', v_nn_ghl;
  RAISE NOTICE '  met NULL ghl_form_submission_id       : % (niet aangeraakt)', v_null_ghl;
  RAISE NOTICE '  ghl_form_submission_id-groups met >1  : %', v_dup_groups;
  RAISE NOTICE '  → rijen die STAP 1 verwijdert          : %', v_dup_rows;
END $$;

-- ═══ STAP 1 · DEDUP BESTAANDE RIJEN ═════════════════════════════════════════
-- Behoud per ghl_form_submission_id de rij met MAX(received_at); bij gelijk:
-- MAX(id) (uuid-vergelijking geeft deterministische winnaar).
-- Alle andere rijen met dezelfde ghl_form_submission_id worden verwijderd.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY ghl_form_submission_id
      ORDER BY received_at DESC NULLS LAST, id DESC
    ) AS rn
  FROM public.event_signup_inbox
  WHERE ghl_form_submission_id IS NOT NULL
),
deleted AS (
  DELETE FROM public.event_signup_inbox
  WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
  RETURNING id
)
SELECT COUNT(*) AS deleted_rows FROM deleted;

DO $$
DECLARE v_after BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_after FROM public.event_signup_inbox WHERE ghl_form_submission_id IS NOT NULL;
  RAISE NOTICE '── event_signup_inbox POST-DEDUP ────────────────────';
  RAISE NOTICE '  non-null ghl_form_submission_id (na)  : %', v_after;
END $$;

-- ═══ STAP 2 · UNIQUE PARTIAL INDEX ══════════════════════════════════════════
-- Voorkomt toekomstige dubbelen op ghl_form_submission_id (non-null).
-- NULL blijft toegestaan meerdere keren (partial index skipt 'em).
CREATE UNIQUE INDEX IF NOT EXISTS event_signup_inbox_ghl_form_submission_id_uidx
  ON public.event_signup_inbox (ghl_form_submission_id)
  WHERE ghl_form_submission_id IS NOT NULL;

DO $$
BEGIN
  RAISE NOTICE '── UNIQUE partial index aangemaakt ──────────────────';
  RAISE NOTICE '  event_signup_inbox_ghl_form_submission_id_uidx OK';
  RAISE NOTICE 'Klaar. Ingest-fix in events-signup-inbound.js gebruikt on-conflict-do-nothing.';
END $$;

COMMIT;
