-- 2026-08-24 · event_signup_inbox — dedup op (ghl_contact_id || email/phone,
-- event_date_label) + drop van de inerte ghl_form_submission_id-index.
--
-- CONTEXT
-- Vorige migratie (2026-08-24-events-signup-inbox-dedup-ghl-form-id.sql)
-- richtte zich op ghl_form_submission_id, maar meting toonde: 100% van de
-- 116 productie-rijen heeft NULL — GHL-webhook stuurt die key niet.
-- De partial unique index werd daardoor INERT en de upsert-on-conflict deed
-- niks. Nieuwe dubbelen bleven binnenkomen.
--
-- NIEUWE SLEUTEL
-- `ghl_contact_id` (stabiel per persoon, wél gevuld) + `event_date_label`
-- (vaste GHL-dropdown, consistent per event). Fallback voor rijen zonder
-- ghl_contact_id: genormaliseerde email OF laatste 9 digits van phone
-- (Lesson-18-patroon uit CLAUDE.md).
--
-- WAT DEZE MIGRATIE DOET
-- Stap 0 : RAISE NOTICE counts vóór mutatie (echt bestaande dubbelen).
-- Stap 1 : DELETE oudere dupe-rijen per (ghl_contact_id, event_date_label)
--          — behoud MAX(received_at); NULL contact-id: fallback op
--          coalesce(lower(email), right(digits(phone), 9)).
-- Stap 2 : DROP INDEX inert `event_signup_inbox_ghl_form_submission_id_uidx`.
-- Stap 3 : CREATE (niet-uniek) INDEX op (ghl_contact_id, event_date_label)
--          voor snelle app-level pre-check-lookups.
-- COMMIT.
--
-- WAAROM GEEN NIEUWE UNIQUE INDEX?
-- Een echte partial unique index op de dedup-sleutel zou vereisen:
-- lower(email) + right(regexp_replace(phone,'\D','','g'), 9) —
-- computed expressions, en dan nog een coalesce daarvan met ghl_contact_id.
-- Dat is een fragiele functional index (ORDER BY / functiedefinities moeten
-- deterministisch zijn; edge cases met NULL vs empty-string vs whitespace).
-- Kosten > baten: de webhook-retries van GHL zitten seconden uit elkaar,
-- een app-level pre-insert-check is snel genoeg (SELECT op de nieuwe niet-
-- unique index is O(log N)). Race-condition-venster (twee gelijktijdige
-- webhooks binnen ~50ms) blijft open, maar dat is een uitzonderingsscenario
-- dat de client-groepering (events-v2 v=47) alsnog cosmetisch afdekt.
--
-- Als de app-level check ooit tekort blijkt te schieten: aparte brok waar
-- we een generated-column `dedup_key text` toevoegen + partial unique index
-- daarop. Nu niet — hou het simpel.
--
-- ROLLBACK
--   BEGIN;
--   DROP INDEX IF EXISTS event_signup_inbox_contact_event_idx;
--   -- Data-restore uit backup indien nodig; dedup is one-way.
--   COMMIT;

BEGIN;

-- ═══ STAP 0 · MEET DE BESTAANDE STAAT ═══════════════════════════════════════
DO $$
DECLARE
  v_total            BIGINT;
  v_nn_contact       BIGINT;
  v_null_contact     BIGINT;
  v_dup_groups_cid   BIGINT;
  v_dup_rows_cid     BIGINT;
  v_dup_groups_all   BIGINT;
  v_dup_rows_all     BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_total FROM public.event_signup_inbox;
  SELECT COUNT(*) INTO v_nn_contact   FROM public.event_signup_inbox WHERE ghl_contact_id IS NOT NULL;
  SELECT COUNT(*) INTO v_null_contact FROM public.event_signup_inbox WHERE ghl_contact_id IS NULL;

  -- Dupes op alleen (ghl_contact_id, event_date_label) — non-null contact
  SELECT COUNT(*) INTO v_dup_groups_cid FROM (
    SELECT ghl_contact_id, event_date_label
    FROM public.event_signup_inbox
    WHERE ghl_contact_id IS NOT NULL AND event_date_label IS NOT NULL
    GROUP BY ghl_contact_id, event_date_label
    HAVING COUNT(*) > 1
  ) t;
  SELECT COALESCE(SUM(cnt - 1), 0) INTO v_dup_rows_cid FROM (
    SELECT ghl_contact_id, event_date_label, COUNT(*) AS cnt
    FROM public.event_signup_inbox
    WHERE ghl_contact_id IS NOT NULL AND event_date_label IS NOT NULL
    GROUP BY ghl_contact_id, event_date_label
    HAVING COUNT(*) > 1
  ) t;

  -- Dupes op fallback-sleutel (coalesce contact/email-lower/phone-last-9).
  -- Postgres accepteert een SELECT-alias niet in HAVING op hetzelfde
  -- SELECT-level → wrap in subquery zodat person_key in outer WHERE
  -- beschikbaar is (v2 fix na 42703 error).
  SELECT COUNT(*) INTO v_dup_groups_all FROM (
    SELECT person_key, event_date_label, cnt FROM (
      SELECT
        COALESCE(
          ghl_contact_id,
          lower(NULLIF(trim(email), '')),
          NULLIF(right(regexp_replace(COALESCE(phone,''), '\D', '', 'g'), 9), '')
        ) AS person_key,
        event_date_label,
        COUNT(*) AS cnt
      FROM public.event_signup_inbox
      WHERE event_date_label IS NOT NULL
      GROUP BY 1, 2
    ) inner_t
    WHERE cnt > 1 AND person_key IS NOT NULL
  ) t;
  SELECT COALESCE(SUM(cnt - 1), 0) INTO v_dup_rows_all FROM (
    SELECT person_key, event_date_label, cnt FROM (
      SELECT
        COALESCE(
          ghl_contact_id,
          lower(NULLIF(trim(email), '')),
          NULLIF(right(regexp_replace(COALESCE(phone,''), '\D', '', 'g'), 9), '')
        ) AS person_key,
        event_date_label,
        COUNT(*) AS cnt
      FROM public.event_signup_inbox
      WHERE event_date_label IS NOT NULL
      GROUP BY 1, 2
    ) inner_t
    WHERE cnt > 1 AND person_key IS NOT NULL
  ) t;

  RAISE NOTICE '── event_signup_inbox PRE-DEDUP (contact + event) ─────────';
  RAISE NOTICE '  totaal rijen                                : %', v_total;
  RAISE NOTICE '  met non-null ghl_contact_id                 : %', v_nn_contact;
  RAISE NOTICE '  met NULL ghl_contact_id (fallback nodig)    : %', v_null_contact;
  RAISE NOTICE '  ── SUBSET (alleen non-null contact) ─────────────────────';
  RAISE NOTICE '  groups (ghl_contact_id,label) met >1        : %', v_dup_groups_cid;
  RAISE NOTICE '  → daaruit rijen die STAP 1 verwijdert       : %', v_dup_rows_cid;
  RAISE NOTICE '  ── VOLLE SLEUTEL (contact OR email OR phone) ────────────';
  RAISE NOTICE '  groups (person_key,label) met >1            : %', v_dup_groups_all;
  RAISE NOTICE '  → daaruit rijen die STAP 1 verwijdert       : %', v_dup_rows_all;
END $$;

-- ═══ STAP 1 · DEDUP BESTAANDE RIJEN ═════════════════════════════════════════
-- Per (person_key, event_date_label): behoud rij met MAX(received_at);
-- bij gelijk MAX(id). person_key = COALESCE(ghl_contact_id, lower(email),
-- right(digits(phone), 9)). Rijen waar person_key én event_date_label NULL
-- zijn worden NIET aangeraakt (geen dedup-mogelijkheid).
WITH keyed AS (
  SELECT
    id,
    COALESCE(
      ghl_contact_id,
      lower(NULLIF(trim(email), '')),
      NULLIF(right(regexp_replace(COALESCE(phone,''), '\D', '', 'g'), 9), '')
    ) AS person_key,
    event_date_label,
    received_at
  FROM public.event_signup_inbox
),
ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY person_key, event_date_label
      ORDER BY received_at DESC NULLS LAST, id DESC
    ) AS rn
  FROM keyed
  WHERE person_key IS NOT NULL AND event_date_label IS NOT NULL
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
  SELECT COUNT(*) INTO v_after FROM public.event_signup_inbox;
  RAISE NOTICE '── event_signup_inbox POST-DEDUP ──────────────────────────';
  RAISE NOTICE '  totaal rijen (na dedup)                     : %', v_after;
END $$;

-- ═══ STAP 2 · DROP INERTE ghl_form_submission_id-INDEX ══════════════════════
-- Deze index werd door 2026-08-24-events-signup-inbox-dedup-ghl-form-id.sql
-- aangemaakt maar beschermt niks omdat de kolom 100% NULL is (GHL stuurt
-- geen submission-id). Weg voor duidelijkheid; kan geen data-corruption
-- geven, alleen een lookup-hulp die nooit gebruikt wordt.
DROP INDEX IF EXISTS public.event_signup_inbox_ghl_form_submission_id_uidx;

-- ═══ STAP 3 · NIEUWE (NIET-UNIQUE) INDEX VOOR APP-LEVEL PRE-CHECK ═══════════
-- Non-unique + partial: alleen non-null contacts (fallback-lookups gaan via
-- email-kolom die zijn eigen index heeft, en phone-lookup is regel-lokaal).
-- Snelheid > 10x tegenover seq-scan bij ~duizenden rijen.
CREATE INDEX IF NOT EXISTS event_signup_inbox_contact_event_idx
  ON public.event_signup_inbox (ghl_contact_id, event_date_label)
  WHERE ghl_contact_id IS NOT NULL;

DO $$
BEGIN
  RAISE NOTICE '── Indices na migratie ────────────────────────────────────';
  RAISE NOTICE '  event_signup_inbox_ghl_form_submission_id_uidx : GEDROPT (was inert)';
  RAISE NOTICE '  event_signup_inbox_contact_event_idx           : AANGEMAAKT (voor pre-check)';
  RAISE NOTICE 'Klaar. Ingest-fix in events-signup-inbound.js gebruikt app-level pre-check';
  RAISE NOTICE 'op (ghl_contact_id || email/phone-fallback + event_date_label).';
END $$;

COMMIT;
