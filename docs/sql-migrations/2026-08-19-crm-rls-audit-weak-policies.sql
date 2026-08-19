-- ============================================================================
-- CRM RLS — AUDIT (READ-ONLY, wijzigt NIETS)
-- Datum: 2026-08-19
-- Project: forex-command-center (Supabase ref nsjnsvlmdhunzqkdvagm)
--
-- WAAROM
-- Bij het aanmaken van een auth-account maakt de trigger handle_new_user()
-- automatisch een rij in public.profiles aan met rol 'viewer' (of 'student').
-- Een deel van de RLS-policies in schema public checkt ALLEEN of er een
-- profiel bestaat:
--     EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid())
-- ZONDER rolcheck. Gevolg: iedere ingelogde gebruiker met een profiel — dus
-- ook de ~82 'viewer'-profielen (grotendeels studenten) — kan CRM-data zoals
-- public.leads lezen.
--
-- WAT DOET DIT BESTAND
-- Niets muteren. Het inventariseert ALLE policies in schema public en deelt ze
-- in 4 categorieën in. Draai dit bestand VOOR de hardening (nulmeting) en
-- NA de hardening (verificatie). Sectie 1 hoort na de hardening 0 rijen te
-- geven; sectie 2 hoort dan de gerepareerde policies te tonen.
--
-- Volledig read-only: alleen SELECT-statements. Veilig op productie.
-- ============================================================================


-- ── 0) Totaaltelling per categorie ──────────────────────────────────────────
-- Snelle nulmeting: hoeveel policies zijn er en hoeveel daarvan zijn zwak?
WITH pol AS (
  SELECT
    p.schemaname,
    p.tablename,
    p.policyname,
    p.cmd,
    p.roles,
    COALESCE(p.qual, '') || ' ' || COALESCE(p.with_check, '') AS expr,
    p.qual,
    p.with_check
  FROM pg_policies p
  WHERE p.schemaname = 'public'
)
SELECT
  CASE
    WHEN expr ~* 'is_crm_staff'                                          THEN '1_gehard (is_crm_staff)'
    WHEN NOT (roles && ARRAY['authenticated','public']::name[])          THEN '2_niet_van_toepassing (anon/service_role-only)'
    WHEN expr ~* '(is_super_admin|has_any_role|user_has_permission|user_roles|\mrole\M)'
                                                                         THEN '3_heeft_rolcheck (ok)'
    WHEN expr !~* '(auth\.uid\(\)|profiles)'                             THEN '4_geen_auth_referentie (handmatig beoordelen)'
    ELSE                                                                      '5_ZWAK — profiel-bestaat zonder rolcheck'
  END                AS categorie,
  count(*)           AS aantal
FROM pol
GROUP BY 1
ORDER BY 1;


-- ── 1) DE ZWAKKE POLICIES — dit is het lek ──────────────────────────────────
-- Policies die (a) gelden voor ingelogde gebruikers, (b) naar profiles of
-- auth.uid() verwijzen, en (c) GEEN enkele rolcheck bevatten.
-- Kolom `wordt_aangepast` toont of de hardening-migratie deze policy
-- automatisch herschrijft, of dat 'ie op de handmatige lijst blijft staan.
SELECT
  p.tablename,
  p.policyname,
  p.cmd,
  p.roles,
  CASE
    WHEN p.tablename LIKE 'lms\_%' ESCAPE '\'
      OR p.tablename LIKE 'hlms\_%' ESCAPE '\'
      OR p.tablename = 'lms_students'
      THEN 'NEE — LMS/student-facing, handmatig beoordelen'
    WHEN p.tablename IN ('profiles', 'user_roles')
      THEN 'JA — met eigen-rij-uitzondering'
    ELSE 'JA'
  END                                                     AS wordt_aangepast,
  p.qual                                                  AS huidige_using,
  p.with_check                                            AS huidige_with_check
FROM pg_policies p
WHERE p.schemaname = 'public'
  AND p.roles && ARRAY['authenticated','public']::name[]
  AND (COALESCE(p.qual,'') || ' ' || COALESCE(p.with_check,'')) ~* '(auth\.uid\(\)|profiles)'
  AND (COALESCE(p.qual,'') || ' ' || COALESCE(p.with_check,''))
      !~* '(is_crm_staff|is_super_admin|has_any_role|user_has_permission|user_roles|\mrole\M)'
ORDER BY p.tablename, p.policyname;


-- ── 2) Al gehard — moet NA de migratie gevuld zijn ──────────────────────────
SELECT
  p.tablename,
  p.policyname,
  p.cmd,
  p.qual        AS using_expr,
  p.with_check  AS with_check_expr
FROM pg_policies p
WHERE p.schemaname = 'public'
  AND (COALESCE(p.qual,'') || ' ' || COALESCE(p.with_check,'')) ~* 'is_crm_staff'
ORDER BY p.tablename, p.policyname;


-- ── 3) Handmatig beoordelen — geen auth-referentie ──────────────────────────
-- Policies zonder verwijzing naar auth.uid()/profiles, bv. `USING (true)`.
-- Die worden BEWUST NIET automatisch herschreven: hier zitten publieke
-- token-pagina's (event-keuze), webhook-inserts en de anon-leesrechten
-- tussen. Loop deze lijst één keer door en beoordeel per regel.
SELECT
  p.tablename,
  p.policyname,
  p.cmd,
  p.roles,
  p.qual        AS using_expr,
  p.with_check  AS with_check_expr
FROM pg_policies p
WHERE p.schemaname = 'public'
  AND (COALESCE(p.qual,'') || ' ' || COALESCE(p.with_check,'')) !~* '(auth\.uid\(\)|profiles)'
  AND (COALESCE(p.qual,'') || ' ' || COALESCE(p.with_check,'')) !~* 'is_crm_staff'
ORDER BY p.tablename, p.policyname;


-- ── 4) Tabellen ZONDER RLS in schema public ─────────────────────────────────
-- Een tabel zonder RLS is voor PostgREST volledig open zodra de rol een
-- GRANT heeft. Even zo belangrijk als een zwakke policy.
SELECT
  c.relname                                    AS tabel,
  c.relrowsecurity                             AS rls_aan,
  (SELECT count(*) FROM pg_policies p
    WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS aantal_policies,
  has_table_privilege('authenticated', c.oid, 'SELECT')        AS authenticated_mag_select
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relrowsecurity = false
  AND has_table_privilege('authenticated', c.oid, 'SELECT')
ORDER BY c.relname;
