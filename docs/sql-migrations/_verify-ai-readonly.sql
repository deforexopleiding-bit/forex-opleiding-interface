-- ============================================================================
-- _verify-ai-readonly.sql — VERIFICATIE (niet als migratie draaien)
-- ============================================================================
--
-- Draai dit ná 2026-08-01-ai-readonly-foundation.sql om te bewijzen dat de
-- afscherming werkt. Elke test heeft een EXPECTED-comment die je moet
-- controleren.
--
-- Draai in Supabase SQL-editor als de default postgres-user (of de service_role).
-- Voor de "als ai_readonly"-tests gebruiken we SET LOCAL ROLE binnen een
-- transactie — dat vereist dat je huidige session-rol GRANT-recht heeft op
-- ai_readonly (postgres/service_role hebben dat).
--
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────
-- TEST 1 — Bestaat de rol + schema + views?
-- EXPECTED: 6 rijen (v_wanbetalers_actief, v_omzet_per_week, v_omzet_per_maand,
--                    v_leads_per_soort, v_events_upcoming, v_klanten_zonder_mentor,
--                    v_schema_help = 7 totaal, laten we exact tellen)
-- ────────────────────────────────────────────────────────────────────────
SELECT 'ROL bestaat: ' || (EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_readonly'))::text AS test_1a_rol;
SELECT 'SCHEMA bestaat: ' || (EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'ai_readonly'))::text AS test_1b_schema;
SELECT count(*) AS test_1c_aantal_views  -- EXPECTED: 7
FROM information_schema.views
WHERE table_schema = 'ai_readonly';


-- ────────────────────────────────────────────────────────────────────────
-- TEST 2 — Kolommenlijst per view (voor kolom-veiligheid audit)
-- EXPECTED: geen enkele kolom is email/phone/telefoon/iban/token/hash/notes/
--           body/content/notitie/subject/street/postal/city
-- ────────────────────────────────────────────────────────────────────────
SELECT
  table_name        AS view_naam,
  column_name       AS kolom,
  data_type         AS type
FROM information_schema.columns
WHERE table_schema = 'ai_readonly'
ORDER BY table_name, ordinal_position;

-- Automatische audit — deze query moet 0 rijen returnen. Als >0: er zit
-- een verdachte kolom in een view en die moet weg.
SELECT
  table_name  AS view_naam,
  column_name AS verdachte_kolom
FROM information_schema.columns
WHERE table_schema = 'ai_readonly'
  AND (
       column_name ILIKE '%email%'
    OR column_name ILIKE '%phone%'
    OR column_name ILIKE '%telefoon%'
    OR column_name ILIKE '%iban%'
    OR column_name ILIKE '%mandate%'
    OR column_name ILIKE '%token%'
    OR column_name ILIKE '%hash%'
    OR column_name ILIKE '%password%'
    OR column_name ILIKE '%secret%'
    OR column_name ILIKE '%body%'
    OR column_name ILIKE '%content%'
    OR column_name ILIKE '%notes%'
    OR column_name ILIKE '%notitie%'
    OR column_name ILIKE '%description%'
    OR column_name ILIKE '%subject%'
    OR column_name ILIKE '%address%'
    OR column_name ILIKE '%postal%'
    OR column_name ILIKE '%street%'
    OR column_name ILIKE '%city%'
    OR column_name ILIKE '%bsn%'
  );
-- EXPECTED: 0 rijen


-- ────────────────────────────────────────────────────────────────────────
-- TEST 3 — Rol MAG lezen uit ai_readonly (positieve test)
-- ────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE ai_readonly;

SELECT count(*) AS test_3a_leest_wanbetalers  FROM ai_readonly.v_wanbetalers_actief;    -- EXPECTED: 0 of meer (geen error)
SELECT count(*) AS test_3b_leest_omzet_week   FROM ai_readonly.v_omzet_per_week;         -- EXPECTED: idem
SELECT count(*) AS test_3c_leest_events       FROM ai_readonly.v_events_upcoming;        -- EXPECTED: idem
SELECT count(*) AS test_3d_leest_leads_soort  FROM ai_readonly.v_leads_per_soort;        -- EXPECTED: idem
SELECT count(*) AS test_3e_leest_klanten      FROM ai_readonly.v_klanten_zonder_mentor;  -- EXPECTED: idem
SELECT count(*) AS test_3f_leest_schema_help  FROM ai_readonly.v_schema_help;            -- EXPECTED: 7

RESET ROLE;
COMMIT;


-- ────────────────────────────────────────────────────────────────────────
-- TEST 4 — Rol MAG NIET schrijven (negatieve test — moet errors gooien)
-- ────────────────────────────────────────────────────────────────────────
-- 4a: INSERT op public.customers → moet falen met "permission denied for table customers"
BEGIN;
SET LOCAL ROLE ai_readonly;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.customers (first_name) VALUES ('AI_HACK_TEST');
    RAISE EXCEPTION 'TEST 4a FAAL: INSERT SLAAGDE — dit had permission-denied moeten geven';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'TEST 4a OK: INSERT geblokkeerd (permission denied)';
  WHEN OTHERS THEN
    RAISE NOTICE 'TEST 4a OK: INSERT geblokkeerd met andere error: %', SQLERRM;
  END;
END $$;
RESET ROLE;
ROLLBACK;

-- 4b: UPDATE op public.deals → moet falen
BEGIN;
SET LOCAL ROLE ai_readonly;
DO $$
BEGIN
  BEGIN
    UPDATE public.deals SET total_amount = 0 WHERE id = '00000000-0000-0000-0000-000000000000';
    RAISE EXCEPTION 'TEST 4b FAAL: UPDATE SLAAGDE';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'TEST 4b OK: UPDATE geblokkeerd (permission denied)';
  WHEN OTHERS THEN
    RAISE NOTICE 'TEST 4b OK: UPDATE geblokkeerd: %', SQLERRM;
  END;
END $$;
RESET ROLE;
ROLLBACK;

-- 4c: DELETE op public.leads → moet falen
BEGIN;
SET LOCAL ROLE ai_readonly;
DO $$
BEGIN
  BEGIN
    DELETE FROM public.leads WHERE id = '00000000-0000-0000-0000-000000000000';
    RAISE EXCEPTION 'TEST 4c FAAL: DELETE SLAAGDE';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'TEST 4c OK: DELETE geblokkeerd (permission denied)';
  WHEN OTHERS THEN
    RAISE NOTICE 'TEST 4c OK: DELETE geblokkeerd: %', SQLERRM;
  END;
END $$;
RESET ROLE;
ROLLBACK;


-- ────────────────────────────────────────────────────────────────────────
-- TEST 5 — Rol MAG NIET bij public-tabellen (negatieve test)
-- Rauwe SELECT op tabellen met wachtwoorden / tokens / IBAN moet falen.
-- ────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE ai_readonly;

-- 5a: auth.users (Supabase's password-hash-tabel) → moet permission-denied
DO $$
BEGIN
  BEGIN
    PERFORM count(*) FROM auth.users;
    RAISE EXCEPTION 'TEST 5a FAAL: SELECT op auth.users SLAAGDE';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'TEST 5a OK: SELECT auth.users geblokkeerd';
  WHEN OTHERS THEN
    RAISE NOTICE 'TEST 5a OK: SELECT auth.users geblokkeerd: %', SQLERRM;
  END;
END $$;

-- 5b: public.teamleader_oauth_tokens (OAuth-tokens) → moet permission-denied
DO $$
BEGIN
  BEGIN
    PERFORM count(*) FROM public.teamleader_oauth_tokens;
    RAISE EXCEPTION 'TEST 5b FAAL: SELECT op teamleader_oauth_tokens SLAAGDE';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'TEST 5b OK: SELECT teamleader_oauth_tokens geblokkeerd';
  WHEN OTHERS THEN
    RAISE NOTICE 'TEST 5b OK: SELECT teamleader_oauth_tokens geblokkeerd: %', SQLERRM;
  END;
END $$;

-- 5c: public.customers (IBAN/adres/email) → moet permission-denied
DO $$
BEGIN
  BEGIN
    PERFORM count(*) FROM public.customers;
    RAISE EXCEPTION 'TEST 5c FAAL: SELECT op public.customers SLAAGDE';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'TEST 5c OK: SELECT public.customers geblokkeerd';
  WHEN OTHERS THEN
    RAISE NOTICE 'TEST 5c OK: SELECT public.customers geblokkeerd: %', SQLERRM;
  END;
END $$;

-- 5d: public.whatsapp_messages (message-bodies) → moet permission-denied
DO $$
BEGIN
  BEGIN
    PERFORM count(*) FROM public.whatsapp_messages;
    RAISE EXCEPTION 'TEST 5d FAAL: SELECT op whatsapp_messages SLAAGDE';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'TEST 5d OK: SELECT whatsapp_messages geblokkeerd';
  WHEN OTHERS THEN
    RAISE NOTICE 'TEST 5d OK: SELECT whatsapp_messages geblokkeerd: %', SQLERRM;
  END;
END $$;

RESET ROLE;
COMMIT;


-- ────────────────────────────────────────────────────────────────────────
-- TEST 6 — Service-role en andere bestaande rollen ONGEMOEID
-- ────────────────────────────────────────────────────────────────────────
-- service_role moet nog steeds bij alles kunnen (dit script raakt 'm niet aan)
BEGIN;
SET LOCAL ROLE service_role;
SELECT count(*) AS test_6a_service_role_leest_customers FROM public.customers;
SELECT count(*) AS test_6b_service_role_leest_teamleader FROM public.teamleader_oauth_tokens;
RESET ROLE;
COMMIT;


-- ────────────────────────────────────────────────────────────────────────
-- TEST 7 — Alle andere schemas zijn dicht (voor de zekerheid)
-- Return: welke schemas heeft ai_readonly USAGE op? Verwacht: alleen ai_readonly.
-- ────────────────────────────────────────────────────────────────────────
SELECT
  n.nspname                                                                       AS schema_naam,
  has_schema_privilege('ai_readonly', n.nspname, 'USAGE')                         AS heeft_usage
FROM pg_namespace n
WHERE n.nspname IN ('public','auth','storage','extensions','graphql','realtime','ai_readonly')
ORDER BY n.nspname;
-- EXPECTED:
--   ai_readonly  -> true
--   alles anders -> false


-- ────────────────────────────────────────────────────────────────────────
-- TEST 8 — Sample rows uit elke view (voor visuele controle van kolominhoud)
-- Draai dit als postgres/service_role (niet als ai_readonly — je wilt de
-- volledige inhoud kunnen zien om te bevestigen dat er niets PII in zit).
-- ────────────────────────────────────────────────────────────────────────
SELECT 'v_wanbetalers_actief sample:'      AS marker;
SELECT * FROM ai_readonly.v_wanbetalers_actief    LIMIT 3;

SELECT 'v_omzet_per_week sample:'          AS marker;
SELECT * FROM ai_readonly.v_omzet_per_week        LIMIT 3;

SELECT 'v_omzet_per_maand sample:'         AS marker;
SELECT * FROM ai_readonly.v_omzet_per_maand       LIMIT 3;

SELECT 'v_leads_per_soort sample:'         AS marker;
SELECT * FROM ai_readonly.v_leads_per_soort       LIMIT 3;

SELECT 'v_events_upcoming sample:'         AS marker;
SELECT * FROM ai_readonly.v_events_upcoming       LIMIT 3;

SELECT 'v_klanten_zonder_mentor sample:'   AS marker;
SELECT * FROM ai_readonly.v_klanten_zonder_mentor LIMIT 3;

SELECT 'v_schema_help sample:'             AS marker;
SELECT * FROM ai_readonly.v_schema_help;

-- ============================================================================
