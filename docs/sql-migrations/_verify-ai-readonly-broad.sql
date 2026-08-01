-- ============================================================================
-- _verify-ai-readonly-broad.sql — verificatie 14 nieuwe views (PR-B)
-- ============================================================================
-- Draai na 2026-08-01-ai-readonly-broad-views.sql in Supabase SQL-editor.
-- Alle tests via has_*_privilege() — geen SET ROLE nodig.
-- ============================================================================


-- TEST 1 — view-count in ai_readonly
SELECT count(*) AS test_1_totaal_views  -- EXPECTED: 23 (7 uit PR-A + 16 nieuwe)
FROM information_schema.views
WHERE table_schema = 'ai_readonly';


-- TEST 2 — Automatische PII-audit op ALLE views in ai_readonly (EXPECTED: 0 rijen)
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


-- TEST 3 — POSITIEF: rol MAG SELECT op alle 14 NIEUWE views (EXPECTED: alle true)
SELECT
  has_table_privilege('ai_readonly', 'ai_readonly.v_klanten_overzicht',          'SELECT')  AS t3_01_klanten_overzicht,
  has_table_privilege('ai_readonly', 'ai_readonly.v_facturen_status_per_klant',  'SELECT')  AS t3_02_facturen_status,
  has_table_privilege('ai_readonly', 'ai_readonly.v_openstaand_per_klant',       'SELECT')  AS t3_03_openstaand,
  has_table_privilege('ai_readonly', 'ai_readonly.v_deals_per_status',           'SELECT')  AS t3_04_deals_status,
  has_table_privilege('ai_readonly', 'ai_readonly.v_deals_per_klant',            'SELECT')  AS t3_05_deals_klant,
  has_table_privilege('ai_readonly', 'ai_readonly.v_verkoop_per_producttype',    'SELECT')  AS t3_06_verkoop_type,
  has_table_privilege('ai_readonly', 'ai_readonly.v_leads_per_status',           'SELECT')  AS t3_07_leads_status,
  has_table_privilege('ai_readonly', 'ai_readonly.v_leads_conversie',            'SELECT')  AS t3_08_leads_conversie,
  has_table_privilege('ai_readonly', 'ai_readonly.v_sales_pijplijn_open',        'SELECT')  AS t3_09_sales_pijplijn,
  has_table_privilege('ai_readonly', 'ai_readonly.v_events_historie',            'SELECT')  AS t3_10_events_historie,
  has_table_privilege('ai_readonly', 'ai_readonly.v_events_belstatus_per_event', 'SELECT')  AS t3_11_events_belstatus,
  has_table_privilege('ai_readonly', 'ai_readonly.v_studenten_per_mentor',       'SELECT')  AS t3_12_studenten_mentor,
  has_table_privilege('ai_readonly', 'ai_readonly.v_mentor_belasting_periode',   'SELECT')  AS t3_13_mentor_belasting,
  has_table_privilege('ai_readonly', 'ai_readonly.v_klanten_met_mentor',         'SELECT')  AS t3_14_klanten_met_mentor,
  has_table_privilege('ai_readonly', 'ai_readonly.v_taken_open_per_persoon',     'SELECT')  AS t3_15_taken_open,
  has_table_privilege('ai_readonly', 'ai_readonly.v_tickets_open_per_module',    'SELECT')  AS t3_16_tickets_open;


-- TEST 4 — NEGATIEF: rol MAG NIET schrijven naar public-tabellen
-- (Zelfde check als PR-A — verifieer dat de nieuwe views geen nieuwe write-rechten hebben geopend)
SELECT
  has_table_privilege('ai_readonly', 'public.customers',            'INSERT')  AS t4_01_customers_insert,
  has_table_privilege('ai_readonly', 'public.customers',            'UPDATE')  AS t4_02_customers_update,
  has_table_privilege('ai_readonly', 'public.customers',            'DELETE')  AS t4_03_customers_delete,
  has_table_privilege('ai_readonly', 'public.deals',                'INSERT')  AS t4_04_deals_insert,
  has_table_privilege('ai_readonly', 'public.deals',                'UPDATE')  AS t4_05_deals_update,
  has_table_privilege('ai_readonly', 'public.deals',                'DELETE')  AS t4_06_deals_delete,
  has_table_privilege('ai_readonly', 'public.invoices',             'INSERT')  AS t4_07_invoices_insert,
  has_table_privilege('ai_readonly', 'public.invoices',             'UPDATE')  AS t4_08_invoices_update,
  has_table_privilege('ai_readonly', 'public.leads',                'INSERT')  AS t4_09_leads_insert,
  has_table_privilege('ai_readonly', 'public.leads',                'DELETE')  AS t4_10_leads_delete,
  has_table_privilege('ai_readonly', 'public.taken_items',          'UPDATE')  AS t4_11_taken_update,
  has_table_privilege('ai_readonly', 'public.tickets',              'UPDATE')  AS t4_12_tickets_update,
  has_table_privilege('ai_readonly', 'public.mentor_ledger_entries','UPDATE')  AS t4_13_ledger_update,
  has_table_privilege('ai_readonly', 'public.event_attendees',      'UPDATE')  AS t4_14_attendees_update,
  has_table_privilege('ai_readonly', 'public.events',               'UPDATE')  AS t4_15_events_update;
-- EXPECTED: alle 15 = false


-- TEST 5 — NEGATIEF: rol MAG NIET SELECT op rauwe/gevoelige tabellen
-- (Uitgebreid met alle tabellen die de nieuwe views achterliggend gebruiken)
SELECT
  has_table_privilege('ai_readonly', 'auth.users',                       'SELECT')  AS t5_01_auth_users,
  has_table_privilege('ai_readonly', 'public.teamleader_oauth_tokens',   'SELECT')  AS t5_02_tl_oauth_tokens,
  has_table_privilege('ai_readonly', 'public.customers',                 'SELECT')  AS t5_03_customers,
  has_table_privilege('ai_readonly', 'public.whatsapp_messages',         'SELECT')  AS t5_04_whatsapp_messages,
  has_table_privilege('ai_readonly', 'public.email_messages',            'SELECT')  AS t5_05_email_messages,
  has_table_privilege('ai_readonly', 'public.leads',                     'SELECT')  AS t5_06_leads,
  has_table_privilege('ai_readonly', 'public.invoices',                  'SELECT')  AS t5_07_invoices,
  has_table_privilege('ai_readonly', 'public.deals',                     'SELECT')  AS t5_08_deals,
  has_table_privilege('ai_readonly', 'public.deal_line_items',           'SELECT')  AS t5_09_deal_line_items,
  has_table_privilege('ai_readonly', 'public.subscriptions',             'SELECT')  AS t5_10_subscriptions,
  has_table_privilege('ai_readonly', 'public.events',                    'SELECT')  AS t5_11_events,
  has_table_privilege('ai_readonly', 'public.event_attendees',           'SELECT')  AS t5_12_event_attendees,
  has_table_privilege('ai_readonly', 'public.mentor_ledger_entries',     'SELECT')  AS t5_13_mentor_ledger,
  has_table_privilege('ai_readonly', 'public.taken_items',               'SELECT')  AS t5_14_taken_items,
  has_table_privilege('ai_readonly', 'public.tickets',                   'SELECT')  AS t5_15_tickets,
  has_table_privilege('ai_readonly', 'public.profiles',                  'SELECT')  AS t5_16_profiles,
  has_table_privilege('ai_readonly', 'public.trajects',                  'SELECT')  AS t5_17_trajects;
-- EXPECTED: alle 17 = false


-- TEST 6 — service_role ongemoeid: MAG nog SELECT op alles + de nieuwe views
SELECT
  has_table_privilege('service_role', 'public.customers',                   'SELECT')  AS t6_01_service_customers,
  has_table_privilege('service_role', 'public.deals',                       'SELECT')  AS t6_02_service_deals,
  has_table_privilege('service_role', 'public.taken_items',                 'SELECT')  AS t6_03_service_taken,
  has_table_privilege('service_role', 'ai_readonly.v_klanten_overzicht',    'SELECT')  AS t6_04_service_ai_klanten,
  has_table_privilege('service_role', 'ai_readonly.v_verkoop_per_producttype','SELECT') AS t6_05_service_ai_verkoop;
-- EXPECTED: alle 5 = true


-- TEST 7 — Schema-toegang overzicht (moet identiek zijn aan post-PR-A staat)
SELECT n.nspname AS schema_naam,
       has_schema_privilege('ai_readonly', n.nspname, 'USAGE') AS heeft_usage
FROM pg_namespace n
WHERE n.nspname IN ('public','auth','storage','extensions','graphql','realtime','ai_readonly')
ORDER BY n.nspname;
-- EXPECTED: alleen ai_readonly = true, rest = false


-- TEST 8 — Kolommen-inspectie per nieuwe view (sample 3 rijen)
-- Kies er zelf een paar om te controleren; hier de complete lijst voor de audit.

SELECT '=== v_klanten_overzicht ===' AS marker;
SELECT * FROM ai_readonly.v_klanten_overzicht          LIMIT 3;

SELECT '=== v_facturen_status_per_klant ===' AS marker;
SELECT * FROM ai_readonly.v_facturen_status_per_klant  LIMIT 3;

SELECT '=== v_openstaand_per_klant ===' AS marker;
SELECT * FROM ai_readonly.v_openstaand_per_klant       LIMIT 3;

SELECT '=== v_deals_per_status ===' AS marker;
SELECT * FROM ai_readonly.v_deals_per_status;

SELECT '=== v_deals_per_klant ===' AS marker;
SELECT * FROM ai_readonly.v_deals_per_klant            LIMIT 3;

SELECT '=== v_verkoop_per_producttype ===' AS marker;
SELECT * FROM ai_readonly.v_verkoop_per_producttype    LIMIT 3;

SELECT '=== v_leads_per_status ===' AS marker;
SELECT * FROM ai_readonly.v_leads_per_status           LIMIT 5;

SELECT '=== v_leads_conversie ===' AS marker;
SELECT * FROM ai_readonly.v_leads_conversie            LIMIT 5;

SELECT '=== v_sales_pijplijn_open ===' AS marker;
SELECT * FROM ai_readonly.v_sales_pijplijn_open;

SELECT '=== v_events_historie ===' AS marker;
SELECT * FROM ai_readonly.v_events_historie            LIMIT 3;

SELECT '=== v_events_belstatus_per_event ===' AS marker;
SELECT * FROM ai_readonly.v_events_belstatus_per_event LIMIT 3;

SELECT '=== v_studenten_per_mentor ===' AS marker;
SELECT * FROM ai_readonly.v_studenten_per_mentor;

SELECT '=== v_mentor_belasting_periode ===' AS marker;
SELECT * FROM ai_readonly.v_mentor_belasting_periode   LIMIT 5;

SELECT '=== v_klanten_met_mentor ===' AS marker;
SELECT * FROM ai_readonly.v_klanten_met_mentor         LIMIT 3;

SELECT '=== v_taken_open_per_persoon ===' AS marker;
SELECT * FROM ai_readonly.v_taken_open_per_persoon;

SELECT '=== v_tickets_open_per_module ===' AS marker;
SELECT * FROM ai_readonly.v_tickets_open_per_module;

SELECT '=== v_schema_help (compleet overzicht van ALLE views + kolommen) ===' AS marker;
SELECT * FROM ai_readonly.v_schema_help ORDER BY view_naam;
