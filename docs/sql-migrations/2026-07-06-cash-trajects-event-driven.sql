-- =============================================================================
-- 2026-07-06 — Handmatige trajecten: event-gedreven bonusverdeling
--
-- Aanpassing op mentor_cash_trajects (van 2026-07-06-mentor-cash-trajects.sql):
-- traject wordt event-gedreven; de cron verdeelt de termijn-bonus over de
-- AANWEZIGE mentoren van het event (event_mentors.was_present=true), niet
-- meer over één vast gekoppelde mentor.
--
-- Wijziging:
--   ALTER COLUMN mentor_user_id DROP NOT NULL
--   (kolom blijft bestaan voor evt. toekomstig 'lock op één mentor'-gebruik,
--    maar is niet meer verplicht bij insert)
--
-- Data-migratie: geen. De tabel is leeg — geen bestaande rijen te muteren.
-- =============================================================================

BEGIN;

ALTER TABLE public.mentor_cash_trajects
  ALTER COLUMN mentor_user_id DROP NOT NULL;

COMMENT ON COLUMN public.mentor_cash_trajects.mentor_user_id IS
  'Optioneel — historisch vanuit één-mentor-per-traject; sinds event-gedreven wordt de bonus verdeeld over event_mentors.was_present=true. Kolom bewaard voor evt. lock-op-één-mentor in de toekomst.';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ROLLBACK
-- ALTER TABLE public.mentor_cash_trajects ALTER COLUMN mentor_user_id SET NOT NULL;
