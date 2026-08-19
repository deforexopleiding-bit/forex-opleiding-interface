-- ============================================================================
-- RLS DRIFT-CHECK — vaste monitor (READ-ONLY, wijzigt NIETS)
-- Laatst bijgewerkt: 2026-08-20
--
-- WAAROM DIT BESTAAT
-- Postgres zet RLS standaard UIT op een nieuwe tabel, en een luie
-- `USING (true)`-policy is in tien seconden geschreven. Zo ontstond het lek van
-- augustus 2026: 69 policies die alleen checkten óf er een profiel bestond
-- (ronde 1), plus 34 tabellen met een kale `true`-policy (ronde 2). Zonder
-- terugkerende controle sluipt dat er bij elke nieuwe tabel opnieuw in.
--
-- Dit bestand is die controle, herbruikbaar gemaakt. Volledig read-only:
-- alleen SELECT's op de catalogus. Veilig op productie, zo vaak als je wilt.
--
-- HOE TE DRAAIEN
--   • handmatig  — plak in de Supabase SQL-editor en Run;
--   • automatisch — .github/workflows/rls-drift-check.yml draait 'm dagelijks
--     en faalt zodra sectie 9 een aantal > 0 teruggeeft.
--
-- WAT IS EEN RISICO-TABEL?
--   1. RLS staat uit terwijl `authenticated` leesrechten heeft;
--   2. een PERMISSIVE policy voor ingelogde gebruikers die NIETS checkt
--      (`true`) of alleen "is er iemand ingelogd" (`auth.uid() IS NOT NULL`,
--      `auth.role() = 'authenticated'`), ZONDER rolcheck.
--
-- WAT IS GEEN RISICO?
--   • policies die `is_crm_staff()`, `is_super_admin()`, `has_any_role()`,
--     `user_has_permission()`, `user_roles` of een `role`-kolom raadplegen;
--   • policies die de rij aan de gebruiker binden (`... = auth.uid()`);
--   • policies voor `anon`/`public` — dat zijn bewust publieke routes
--     (website-quiz, event-keuze, webhook-inserts). Die staan apart in
--     sectie 3, ter beoordeling, niet als alarm.
--   • `lms_*` / `hlms_*` — student-facing, met een eigen student-check.
-- ============================================================================


-- ── 1) RISICO: tabellen ZONDER RLS die `authenticated` mag lezen ───────────
SELECT
  'RLS_UIT'                                             AS risico,
  c.relname                                             AS tabel,
  has_table_privilege('authenticated', c.oid, 'SELECT') AS auth_mag_select,
  has_table_privilege('anon',          c.oid, 'SELECT') AS anon_mag_select
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relrowsecurity = false
  AND has_table_privilege('authenticated', c.oid, 'SELECT')
ORDER BY c.relname;


-- ── 2) RISICO: policies voor ingelogde gebruikers zonder rolcheck ──────────
SELECT
  'GEEN_ROLCHECK'  AS risico,
  p.tablename,
  p.policyname,
  p.cmd,
  p.roles,
  p.qual           AS using_expr,
  p.with_check     AS with_check_expr
FROM pg_policies p
WHERE p.schemaname = 'public'
  AND p.permissive = 'PERMISSIVE'
  AND p.roles && ARRAY['authenticated']::name[]
  -- checkt niets, of alleen "er is iemand ingelogd"
  AND (
        COALESCE(p.qual,'')       = 'true'
     OR COALESCE(p.with_check,'') = 'true'
     OR (COALESCE(p.qual,'') || ' ' || COALESCE(p.with_check,''))
          ~* '(auth\.uid\(\)\s+IS\s+NOT\s+NULL|auth\.role\(\)\s*=\s*''authenticated'')'
  )
  -- ... en bevat geen enkele rol- of eigenaarsbinding
  AND (COALESCE(p.qual,'') || ' ' || COALESCE(p.with_check,''))
      !~* '(is_crm_staff|is_super_admin|has_any_role|user_has_permission|user_roles|\mrole\M)'
  AND (COALESCE(p.qual,'') || ' ' || COALESCE(p.with_check,''))
      !~* '=\s*auth\.uid\(\)'
  -- student-facing tabellen hebben hun eigen check
  AND p.tablename <> 'lms_students'
  AND p.tablename NOT LIKE 'lms\_%'
  AND p.tablename NOT LIKE 'hlms\_%'
ORDER BY p.tablename, p.policyname;


-- ── 3) TER BEOORDELING: bewust publieke routes (anon/public) ───────────────
-- Geen alarm — hier hangen de publieke token-pagina's en webhook-inserts aan.
-- Loop deze lijst door bij elke nieuwe regel: hoort die er echt te staan?
SELECT
  'PUBLIEK_BEOORDELEN' AS status,
  p.tablename,
  p.policyname,
  p.cmd,
  p.roles,
  p.qual        AS using_expr,
  p.with_check  AS with_check_expr
FROM pg_policies p
WHERE p.schemaname = 'public'
  AND p.permissive = 'PERMISSIVE'
  AND p.roles && ARRAY['anon','public']::name[]
  AND (COALESCE(p.qual,'') = 'true' OR COALESCE(p.with_check,'') = 'true')
ORDER BY p.tablename, p.policyname;


-- ── 4) TER BEOORDELING: RLS aan, maar géén enkele policy ───────────────────
-- Zo'n tabel is voor iedereen behalve service_role volledig dicht. Meestal
-- bedoeld (alleen API-toegang), maar soms een vergeten policy.
SELECT
  'RLS_AAN_ZONDER_POLICY' AS status,
  c.relname               AS tabel
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relrowsecurity = true
  AND NOT EXISTS (
    SELECT 1 FROM pg_policies p
    WHERE p.schemaname = 'public' AND p.tablename = c.relname
  )
ORDER BY c.relname;


-- ── 9) SAMENVATTING — dit getal gebruikt de CI-stap ────────────────────────
-- 0 = schoon. Alles daarboven is een risico-tabel die aandacht vraagt.
-- LET OP: sectie 3 en 4 tellen hier BEWUST niet mee; dat zijn beoordelings-
-- lijsten, geen alarm. Alleen sectie 1 en 2 zijn hard falen.
WITH zonder_rls AS (
  SELECT c.relname AS tabel
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = false
    AND has_table_privilege('authenticated', c.oid, 'SELECT')
),
zonder_rolcheck AS (
  SELECT p.tablename AS tabel
  FROM pg_policies p
  WHERE p.schemaname = 'public'
    AND p.permissive = 'PERMISSIVE'
    AND p.roles && ARRAY['authenticated']::name[]
    AND (
          COALESCE(p.qual,'')       = 'true'
       OR COALESCE(p.with_check,'') = 'true'
       OR (COALESCE(p.qual,'') || ' ' || COALESCE(p.with_check,''))
            ~* '(auth\.uid\(\)\s+IS\s+NOT\s+NULL|auth\.role\(\)\s*=\s*''authenticated'')'
    )
    AND (COALESCE(p.qual,'') || ' ' || COALESCE(p.with_check,''))
        !~* '(is_crm_staff|is_super_admin|has_any_role|user_has_permission|user_roles|\mrole\M)'
    AND (COALESCE(p.qual,'') || ' ' || COALESCE(p.with_check,''))
        !~* '=\s*auth\.uid\(\)'
    AND p.tablename <> 'lms_students'
    AND p.tablename NOT LIKE 'lms\_%'
    AND p.tablename NOT LIKE 'hlms\_%'
)
SELECT count(DISTINCT tabel) AS risico_tabellen
FROM (SELECT tabel FROM zonder_rls UNION SELECT tabel FROM zonder_rolcheck) x;
