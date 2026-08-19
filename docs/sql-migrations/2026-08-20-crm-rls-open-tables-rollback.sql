-- ============================================================================
-- ROLLBACK van 2026-08-20-crm-rls-open-tables-hardening.sql (ronde 2)
-- Datum: 2026-08-20
--
-- Zet elke policy uit ronde 2 terug naar de expressie van vóór die migratie,
-- op basis van public.rls_hardening_log. Filtert op batch, dus ronde 1
-- (2026-08-19, de profiel-bestaat-policies) blijft ONGEMOEID.
--
-- ⚠ Alleen draaien als er echt iets stuk is. Na deze rollback mag elke
--   ingelogde gebruiker — ook viewer/student — die tabellen weer lezen.
-- ============================================================================

-- Wat zit er in ronde 2? (draai dit eerst)
SELECT tablename, policyname, cmd, applied_at
FROM public.rls_hardening_log
WHERE batch = '2026-08-20-open-tables'
ORDER BY tablename, policyname;


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
    WHERE batch = '2026-08-20-open-tables'
    ORDER BY schemaname, tablename, policyname, applied_at ASC  -- oudste = originele staat
  LOOP
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

  RAISE NOTICE '--- rollback ronde 2 klaar: % policies teruggezet ---', v_total;
END
$do$;

-- Wil je één specifieke tabel terug in plaats van alles? Voeg
--   AND tablename = '<naam>'
-- toe aan de WHERE in het DO-block hierboven.
