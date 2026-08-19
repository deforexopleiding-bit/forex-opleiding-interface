-- ============================================================================
-- CRM RLS — ROLLBACK van 2026-08-19-crm-rls-role-check-hardening.sql
-- Datum: 2026-08-19
--
-- Zet elke gewrapte policy terug naar de expressie zoals die vóór de hardening
-- was. Bron van waarheid is public.rls_hardening_log (old_qual/old_with_check),
-- dus dit werkt ook als je de policy-definities zelf niet meer hebt.
--
-- Standaard rolt dit ALLE runs terug. Wil je één run terugdraaien: zet de
-- run_id in de WHERE hieronder (zie SELECT DISTINCT run_id ... onderaan).
--
-- ⚠ Alleen draaien als er echt iets stuk is. Na deze rollback staat het lek
--   weer open: iedere ingelogde viewer/student kan CRM-data lezen.
-- ============================================================================

-- Welke runs zijn er? (draai dit eerst als je selectief wilt terugdraaien)
SELECT run_id, count(*) AS policies, min(applied_at) AS gedraaid_op
FROM public.rls_hardening_log
GROUP BY run_id
ORDER BY min(applied_at) DESC;


DO $do$
DECLARE
  r       record;
  v_sql   text;
  v_total int := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT ON (schemaname, tablename, policyname)
           schemaname, tablename, policyname, old_qual, old_with_check
    FROM public.rls_hardening_log
    -- WHERE run_id = '00000000-0000-0000-0000-000000000000'::uuid
    ORDER BY schemaname, tablename, policyname, applied_at ASC  -- oudste = originele staat
  LOOP
    -- Bestaat de policy nog? Zo niet: overslaan i.p.v. de hele rollback laten falen.
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname = r.schemaname
        AND p.tablename  = r.tablename
        AND p.policyname = r.policyname
    ) THEN
      RAISE WARNING 'Policy bestaat niet meer, overgeslagen: %.% / %',
        r.schemaname, r.tablename, r.policyname;
      CONTINUE;
    END IF;

    v_sql := format('ALTER POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
    IF r.old_qual IS NOT NULL THEN
      v_sql := v_sql || format(' USING (%s)', r.old_qual);
    END IF;
    IF r.old_with_check IS NOT NULL THEN
      v_sql := v_sql || format(' WITH CHECK (%s)', r.old_with_check);
    END IF;

    EXECUTE v_sql;
    v_total := v_total + 1;
    RAISE NOTICE 'Teruggezet: %.% / %', r.schemaname, r.tablename, r.policyname;
  END LOOP;

  RAISE NOTICE '--- rollback klaar: % policies teruggezet ---', v_total;
END
$do$;

-- is_crm_staff() blijft bewust bestaan (ongebruikt is onschadelijk, en zo kun
-- je opnieuw harden zonder de functie te herbouwen). Weg willen?
--   DROP FUNCTION IF EXISTS public.is_crm_staff();
