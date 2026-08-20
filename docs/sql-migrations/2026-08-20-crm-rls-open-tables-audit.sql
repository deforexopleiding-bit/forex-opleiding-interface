-- ============================================================================
-- CRM RLS — AUDIT van de resterende open tabellen (READ-ONLY, wijzigt NIETS)
-- Datum: 2026-08-20
-- Project: forex-command-center (Supabase ref nsjnsvlmdhunzqkdvagm)
--
-- CONTEXT
-- De hardening van 2026-08-19 (#1329) sloot elke policy die alléén checkte of
-- er een profiel bestaat: 69 policies gehard. Wat die run BEWUST niet raakte
-- zijn de policies zonder enige auth-referentie — `USING (true)` — want daar
-- zitten publieke token-pagina's en webhook-inserts tussen. Maxim telde er
-- 34 met `in_log = 0`.
--
-- Dit bestand inventariseert die groep en toont per policy welk besluit de
-- bijbehorende migratie (2026-08-20-crm-rls-open-tables-hardening.sql) neemt.
-- Draai het VOOR en NA de migratie.
--
-- Volledig read-only. Veilig op productie.
-- ============================================================================


-- ── 0) Overzicht: wat gebeurt er met elke 'true'-policy? ────────────────────
-- `besluit` spiegelt exact de WHERE van het DO-block in de hardening.
WITH pol AS (
  SELECT p.schemaname, p.tablename, p.policyname, p.cmd, p.roles, p.permissive,
         p.qual, p.with_check,
         COALESCE(p.qual,'') || ' ' || COALESCE(p.with_check,'') AS expr
  FROM pg_policies p
  WHERE p.schemaname = 'public'
)
SELECT
  CASE
    WHEN expr ~* 'is_crm_staff'                                  THEN 'A_al_gehard'
    -- COALESCE nodig: `qual='true' OR NULL='true'` levert NULL i.p.v. FALSE,
    -- en een NULL-tak vuurt nooit — dan zou deze policy doorvallen naar D/E/F.
    WHEN NOT (COALESCE(qual,'') = 'true' OR COALESCE(with_check,'') = 'true')
                                                                 THEN 'B_geen_true_policy'
    WHEN permissive <> 'PERMISSIVE'                              THEN 'C_restrictive_niet_van_toepassing'
    WHEN roles <> ARRAY['authenticated']::name[]                 THEN 'D_anon_of_public — NIET aanraken'
    WHEN tablename = ANY (ARRAY['lms_students','rls_hardening_log'])
      OR tablename LIKE 'lms\_%' OR tablename LIKE 'hlms\_%'     THEN 'E_LMS/trials — overgeslagen'
    ELSE                                                              'F_WORDT_DICHTGEZET'
  END        AS besluit,
  count(*)   AS policies,
  count(DISTINCT tablename) AS tabellen
FROM pol
GROUP BY 1
ORDER BY 1;


-- ── 1) De policies die dichtgaan — met of ik de tabel heb kunnen beoordelen ─
-- `beoordeeld` = stond de tabel in de repo-migraties of in Maxim's lijst?
-- Alles met 'ONBEKEND — graag review' heb ik niet kunnen inspecteren omdat de
-- live DB verder is gedrift dan de repo; die gaan wél dicht (veilige default),
-- maar verdienen jouw blik.
WITH bekend(tablename, reden) AS (VALUES
  -- gevoelige CRM-data (uit Maxim's steekproef)
  ('customer_notes',            'Klantnotities — PII, uitsluitend CRM-staff'),
  ('audit_log',                 'Audit-trail — wie wat wanneer deed, nooit klant-zichtbaar'),
  ('customer_tags',             'Klant-labels — CRM-segmentatie'),
  ('customer_tag_definitions',  'Labeldefinities — CRM-configuratie'),
  ('avg_data_requests',         'AVG-verzoeken — juridisch gevoelig, geen self-service-portaal'),
  -- uit de repo-migraties
  ('assessment_questions',      'Publieke assessment leest via /api/assessment-questions (service-role, bypasst RLS)'),
  ('email_templates',           'E-mailsjablonen — staff-tooling'),
  ('email_signatures',          'E-mailhandtekeningen — staff-tooling'),
  ('event_niveau_options',      'Events-lookup — alleen staff-UI'),
  ('event_tags_catalog',        'Events-lookup — alleen staff-UI'),
  ('kb_tags',                   'Kennisbank-tags — staff-tooling'),
  ('kb_item_tags',              'Kennisbank-koppeltabel — staff-tooling'),
  ('lisa_settings',             'Lisa-configuratie — staff; GHL-webhooks draaien op service-role'),
  ('role_permissions',          'RBAC-matrix — alleen admin.html leest dit, en dat is een staff-pagina')
)
SELECT
  p.tablename,
  p.policyname,
  p.cmd,
  COALESCE(b.reden, 'ONBEKEND — graag review door Maxim') AS reden,
  p.qual        AS huidige_using,
  p.with_check  AS huidige_with_check
FROM pg_policies p
LEFT JOIN bekend b ON b.tablename = p.tablename
WHERE p.schemaname = 'public'
  AND p.permissive = 'PERMISSIVE'
  AND (p.qual = 'true' OR p.with_check = 'true')
  AND p.roles = ARRAY['authenticated']::name[]
  AND (COALESCE(p.qual,'') || ' ' || COALESCE(p.with_check,'')) !~* 'is_crm_staff'
  AND p.tablename <> 'lms_students'
  AND p.tablename <> 'rls_hardening_log'
  AND p.tablename NOT LIKE 'lms\_%'
  AND p.tablename NOT LIKE 'hlms\_%'
ORDER BY (b.tablename IS NULL) DESC, p.tablename, p.policyname;


-- ── 2) BEWUST NIET aangeraakt: anon/public 'true'-policies ─────────────────
-- Hier zitten de publieke pagina's (website-quiz, event-keuze) en
-- webhook-inserts. Dichtzetten zou die breken. Loop de lijst één keer door en
-- bevestig dat elke regel een bedoelde publieke route is.
SELECT p.tablename, p.policyname, p.cmd, p.roles, p.qual, p.with_check
FROM pg_policies p
WHERE p.schemaname = 'public'
  AND p.permissive = 'PERMISSIVE'
  AND (p.qual = 'true' OR p.with_check = 'true')
  AND p.roles <> ARRAY['authenticated']::name[]
ORDER BY p.tablename, p.policyname;


-- ── 3) LMS/trials — overgeslagen, handmatig beoordelen ─────────────────────
SELECT p.tablename, p.policyname, p.cmd, p.roles, p.qual, p.with_check
FROM pg_policies p
WHERE p.schemaname = 'public'
  AND (p.qual = 'true' OR p.with_check = 'true')
  AND (p.tablename = 'lms_students' OR p.tablename LIKE 'lms\_%' OR p.tablename LIKE 'hlms\_%')
ORDER BY p.tablename, p.policyname;


-- ── 4) Tabellen ZONDER RLS — het andere gat ────────────────────────────────
-- Een tabel zonder RLS is voor PostgREST volledig open zodra `authenticated`
-- een GRANT heeft. Geen policy nodig om te lekken.
SELECT
  c.relname                                             AS tabel,
  c.relrowsecurity                                      AS rls_aan,
  has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated_mag_select
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relrowsecurity = false
  AND has_table_privilege('authenticated', c.oid, 'SELECT')
ORDER BY c.relname;
