-- ============================================================================
-- _verify-ai-readonly.sql — v2 (Supabase-editor-compatibel, geen SET ROLE)
-- ============================================================================
--
-- Draai in Supabase SQL-editor als de default postgres/editor-user. Alle
-- tests gebruiken has_*_privilege() — leest de Postgres-catalog rechtstreeks,
-- geen SET LOCAL ROLE nodig (die faalt in Supabase omdat de editor-rol geen
-- membership heeft in ai_readonly — dat is correct/veilig gedrag, geen bug).
--
-- Elke test heeft EXPECTED-comments. Alles moet groen zijn voor PR-A verified.
-- ============================================================================


-- TEST 1 — Rol + schema + view-count bestaan
SELECT
  EXISTS (SELECT 1 FROM pg_roles     WHERE rolname = 'ai_readonly')  AS test_1a_rol_bestaat,        -- EXPECTED: true
  EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'ai_readonly')  AS test_1b_schema_bestaat;     -- EXPECTED: true

SELECT count(*) AS test_1c_aantal_views  -- EXPECTED: 7
FROM information_schema.views
WHERE table_schema = 'ai_readonly';


-- TEST 2 — Automatische PII-audit op kolomnamen (EXPECTED: 0 rijen)
SELECT table_name AS view_naam, column_name AS verdachte_kolom
FROM information_schema.columns
WHERE table_schema = 'ai_readonly'
  AND (
       column_name ILIKE '%email%'    OR column_name ILIKE '%phone%'
    OR column_name ILIKE '%telefoon%' OR column_name ILIKE '%iban%'
    OR column_name ILIKE '%mandate%'  OR column_name ILIKE '%token%'
    OR column_name ILIKE '%hash%'     OR column_name ILIKE '%password%'
    OR column_name ILIKE '%secret%'   OR column_name ILIKE '%body%'
    OR column_name ILIKE '%content%'  OR column_name ILIKE '%notes%'
    OR column_name ILIKE '%notitie%'  OR column_name ILIKE '%description%'
    OR column_name ILIKE '%subject%'  OR column_name ILIKE '%address%'
    OR column_name ILIKE '%postal%'   OR column_name ILIKE '%street%'
    OR column_name ILIKE '%city%'     OR column_name ILIKE '%bsn%'
  );


-- TEST 3 — POSITIEF: rol MAG SELECT op alle 7 views (EXPECTED: alle true)
SELECT
  has_schema_privilege('ai_readonly', 'ai_readonly', 'USAGE')                                    AS test_3a_schema_usage,
  has_table_privilege ('ai_readonly', 'ai_readonly.v_wanbetalers_actief',    'SELECT')           AS test_3b_wanbetalers,
  has_table_privilege ('ai_readonly', 'ai_readonly.v_omzet_per_week',        'SELECT')           AS test_3c_omzet_week,
  has_table_privilege ('ai_readonly', 'ai_readonly.v_omzet_per_maand',       'SELECT')           AS test_3d_omzet_maand,
  has_table_privilege ('ai_readonly', 'ai_readonly.v_leads_per_soort',       'SELECT')           AS test_3e_leads,
  has_table_privilege ('ai_readonly', 'ai_readonly.v_events_upcoming',       'SELECT')           AS test_3f_events,
  has_table_privilege ('ai_readonly', 'ai_readonly.v_klanten_zonder_mentor', 'SELECT')           AS test_3g_klanten,
  has_table_privilege ('ai_readonly', 'ai_readonly.v_schema_help',           'SELECT')           AS test_3h_schema_help;


-- TEST 4 — NEGATIEF: rol MAG NIET schrijven naar public-tabellen (EXPECTED: alle false)
SELECT
  has_table_privilege('ai_readonly', 'public.customers', 'INSERT')  AS test_4a_customers_insert,
  has_table_privilege('ai_readonly', 'public.customers', 'UPDATE')  AS test_4b_customers_update,
  has_table_privilege('ai_readonly', 'public.customers', 'DELETE')  AS test_4c_customers_delete,
  has_table_privilege('ai_readonly', 'public.deals',     'INSERT')  AS test_4d_deals_insert,
  has_table_privilege('ai_readonly', 'public.deals',     'UPDATE')  AS test_4e_deals_update,
  has_table_privilege('ai_readonly', 'public.leads',     'DELETE')  AS test_4f_leads_delete;


-- TEST 5 — NEGATIEF: rol MAG NIET SELECT op rauwe/gevoelige tabellen (EXPECTED: alle false)
SELECT
  has_table_privilege('ai_readonly', 'auth.users',                       'SELECT')  AS test_5a_auth_users,
  has_table_privilege('ai_readonly', 'public.teamleader_oauth_tokens',   'SELECT')  AS test_5b_tl_oauth_tokens,
  has_table_privilege('ai_readonly', 'public.customers',                 'SELECT')  AS test_5c_customers_raw,
  has_table_privilege('ai_readonly', 'public.whatsapp_messages',         'SELECT')  AS test_5d_whatsapp_messages,
  has_table_privilege('ai_readonly', 'public.email_messages',            'SELECT')  AS test_5e_email_messages,
  has_table_privilege('ai_readonly', 'public.leads',                     'SELECT')  AS test_5f_leads_raw,
  has_table_privilege('ai_readonly', 'public.invoices',                  'SELECT')  AS test_5g_invoices_raw,
  has_table_privilege('ai_readonly', 'public.deals',                     'SELECT')  AS test_5h_deals_raw;


-- TEST 6 — service_role ongemoeid: MAG nog SELECT op alles (EXPECTED: alle true)
SELECT
  has_table_privilege('service_role', 'public.customers',                 'SELECT')  AS test_6a_service_customers,
  has_table_privilege('service_role', 'public.teamleader_oauth_tokens',   'SELECT')  AS test_6b_service_tl_tokens,
  has_table_privilege('service_role', 'public.deals',                     'SELECT')  AS test_6c_service_deals,
  has_table_privilege('service_role', 'ai_readonly.v_wanbetalers_actief', 'SELECT')  AS test_6d_service_leest_ai_views;


-- TEST 7 — Schema-USAGE overzicht (EXPECTED: alleen ai_readonly = true)
SELECT n.nspname AS schema_naam,
       has_schema_privilege('ai_readonly', n.nspname, 'USAGE') AS heeft_usage
FROM pg_namespace n
WHERE n.nspname IN ('public','auth','storage','extensions','graphql','realtime','ai_readonly')
ORDER BY n.nspname;


-- TEST 8 — Sample rijen per view (visuele PII-controle)
SELECT 'v_wanbetalers_actief:' AS marker;
SELECT * FROM ai_readonly.v_wanbetalers_actief    LIMIT 3;

SELECT 'v_omzet_per_week:' AS marker;
SELECT * FROM ai_readonly.v_omzet_per_week        LIMIT 3;

SELECT 'v_omzet_per_maand:' AS marker;
SELECT * FROM ai_readonly.v_omzet_per_maand       LIMIT 3;

SELECT 'v_leads_per_soort:' AS marker;
SELECT * FROM ai_readonly.v_leads_per_soort       LIMIT 3;

SELECT 'v_events_upcoming:' AS marker;
SELECT * FROM ai_readonly.v_events_upcoming       LIMIT 3;

SELECT 'v_klanten_zonder_mentor:' AS marker;
SELECT * FROM ai_readonly.v_klanten_zonder_mentor LIMIT 3;

SELECT 'v_schema_help:' AS marker;
SELECT * FROM ai_readonly.v_schema_help;
