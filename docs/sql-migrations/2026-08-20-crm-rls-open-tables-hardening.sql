-- ============================================================================
-- CRM RLS — HARDENING RONDE 2: de open `USING (true)`-tabellen
-- Datum: 2026-08-20
-- Project: forex-command-center (Supabase ref nsjnsvlmdhunzqkdvagm)
-- Branch: claude/crm-rls-open-tables-hardening
--
-- ⚠ DRAAI EERST docs/sql-migrations/2026-08-20-crm-rls-open-tables-audit.sql
--   (read-only) en bewaar de output. Dat is je nulmeting én je bewijs.
--
-- CONTEXT
-- Ronde 1 (2026-08-19, #1329) sloot 69 policies die alléén checkten óf er een
-- profiel bestond. Bewust buiten scope bleven toen de policies zónder enige
-- auth-referentie — `USING (true)` — omdat daar publieke token-pagina's en
-- webhook-inserts tussen zitten. Maxim telde er 34 met `in_log = 0`, met
-- namen als customer_notes, audit_log, customer_tags, avg_data_requests.
-- Voor die tabellen betekent `true` nog steeds: elke ingelogde gebruiker,
-- inclusief elk auto-aangemaakt viewer/student-account, mag lezen.
--
-- WAT DIT BESTAND DOET
-- Elke PERMISSIVE `true`-policy die uitsluitend aan `authenticated` is
-- toegekend, krijgt de rolpoort uit ronde 1:
--     USING ( public.is_crm_staff() )
-- Voor CRM-staff verandert er niets (die gaf al true op alles); voor
-- viewer/student klapt de deur dicht.
--
-- WAAROM DIT VEILIG IS VOOR DE CRM-UI
-- De browser praat maar met acht tabellen rechtstreeks via PostgREST —
-- customers, email_replies, follow_up_appointments, follow_up_screenshot_audit,
-- profiles, role_permissions, taken_attachments, taken_watchers — en dat
-- gebeurt uitsluitend vanaf staff-pagina's. Al het andere loopt via
-- /api/*-endpoints op de service-role client, en die omzeilt RLS volledig.
-- Voorbeeld: de publieke assessment-pagina leest haar vragen via
-- /api/assessment-questions → supabaseAdmin, niet via de policy op
-- assessment_questions.
--
-- NIET AANGERAAKT (bewust)
--   • policies die óók aan `anon` of `public` zijn toegekend — daar hangen de
--     publieke token-pagina's (website-quiz, event-keuze) en webhook-inserts
--     aan. Dichtzetten zou die breken. Ze staan in sectie 2 van het
--     audit-bestand, voor handmatige beoordeling.
--   • RESTRICTIVE policies — die beperken al, wrappen heeft geen zin.
--   • public.lms_students (trials) en alles onder lms_* / hlms_* — die worden
--     door studenten met hun eigen JWT gelezen.
--   • public.rls_hardening_log zelf.
--
-- IDEMPOTENT. Tweede run past 0 policies aan.
-- ROLLBACK: docs/sql-migrations/2026-08-20-crm-rls-open-tables-rollback.sql
-- ============================================================================


-- ── 1) Logtabel uitbreiden met een batch-label ──────────────────────────────
-- Ronde 1 schreef al naar deze tabel. Met een batch-kolom kun je beide rondes
-- los van elkaar terugdraaien. Bestaande rijen houden batch = NULL (= ronde 1).
CREATE TABLE IF NOT EXISTS public.rls_hardening_log (
  id              bigserial PRIMARY KEY,
  run_id          uuid        NOT NULL,
  schemaname      text        NOT NULL,
  tablename       text        NOT NULL,
  policyname      text        NOT NULL,
  cmd             text,
  roles           text[],
  old_qual        text,
  old_with_check  text,
  new_qual        text,
  new_with_check  text,
  applied_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.rls_hardening_log ADD COLUMN IF NOT EXISTS batch text;

COMMENT ON COLUMN public.rls_hardening_log.batch IS
  'Welke hardening-ronde deze rij schreef. NULL = ronde 1 (2026-08-19, '
  'profiel-bestaat-policies). ''2026-08-20-open-tables'' = ronde 2 (true-policies).';


-- ── 2) is_crm_staff() moet bestaan ──────────────────────────────────────────
-- Harde stop als ronde 1 niet gedraaid is: zonder de rolpoort zou dit bestand
-- policies stukmaken in plaats van dichtzetten.
DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'is_crm_staff'
  ) THEN
    RAISE EXCEPTION 'public.is_crm_staff() bestaat niet — draai eerst '
                    '2026-08-19-crm-rls-role-check-hardening.sql';
  END IF;
END
$check$;


-- ── 3) De rewrite ───────────────────────────────────────────────────────────
-- Eén DO-block, alles-of-niets (de Supabase SQL-editor draait elk statement in
-- een eigen transactie — zie CLAUDE.md, dus geen state over blokken heen).
--
-- KEEP_OPEN hieronder is BEWUST LEEG. Er is geen CRM-tabel die door een
-- niet-staff-account gelezen moet worden: de publieke routes lopen via
-- service-role-endpoints of via anon-policies (die we niet aanraken), en de
-- LMS-tabellen zijn uitgesloten op prefix. Moet een tabel toch open blijven,
-- zet 'm hier neer MET een reden erboven — dan blijft de uitzondering
-- zichtbaar in code review in plaats van te verdwijnen in een handmatige
-- ALTER achteraf.
DO $do$
DECLARE
  r          record;
  v_run_id   uuid := gen_random_uuid();
  v_batch    text := '2026-08-20-open-tables';
  v_sql      text;
  v_new_q    text;
  v_new_c    text;
  v_total    int  := 0;
  KEEP_OPEN  text[] := ARRAY[]::text[];   -- zie toelichting hierboven
BEGIN
  FOR r IN
    SELECT p.schemaname, p.tablename, p.policyname, p.cmd, p.roles,
           p.qual, p.with_check
    FROM pg_policies p
    WHERE p.schemaname = 'public'
      AND p.permissive = 'PERMISSIVE'
      -- de kern: een policy die niets checkt
      AND (p.qual = 'true' OR p.with_check = 'true')
      -- uitsluitend voor ingelogde gebruikers; anon/public blijft ongemoeid
      AND p.roles = ARRAY['authenticated']::name[]
      -- nog niet gehard
      AND (COALESCE(p.qual,'') || ' ' || COALESCE(p.with_check,'')) !~* 'is_crm_staff'
      -- uitsluitingen
      AND NOT (p.tablename = ANY (KEEP_OPEN))
      AND p.tablename <> 'lms_students'
      AND p.tablename <> 'rls_hardening_log'
      AND p.tablename NOT LIKE 'lms\_%'
      AND p.tablename NOT LIKE 'hlms\_%'
    ORDER BY p.tablename, p.policyname
  LOOP
    -- `true AND is_crm_staff()` is gewoon `is_crm_staff()`. Een qual die iets
    -- ánders is dan puur 'true' (bv. een INSERT-policy met with_check = true
    -- en een echte using) wrappen we wél, zodat er niets verloren gaat.
    v_new_q := NULL;
    v_new_c := NULL;

    IF r.qual IS NOT NULL THEN
      v_new_q := CASE WHEN r.qual = 'true'
                      THEN 'public.is_crm_staff()'
                      ELSE format('public.is_crm_staff() AND (%s)', r.qual) END;
    END IF;

    IF r.with_check IS NOT NULL THEN
      v_new_c := CASE WHEN r.with_check = 'true'
                      THEN 'public.is_crm_staff()'
                      ELSE format('public.is_crm_staff() AND (%s)', r.with_check) END;
    END IF;

    IF v_new_q IS NULL AND v_new_c IS NULL THEN
      RAISE WARNING 'Overgeslagen (geen expressie): %.% / %',
        r.schemaname, r.tablename, r.policyname;
      CONTINUE;
    END IF;

    v_sql := format('ALTER POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
    IF v_new_q IS NOT NULL THEN v_sql := v_sql || format(' USING (%s)', v_new_q); END IF;
    IF v_new_c IS NOT NULL THEN v_sql := v_sql || format(' WITH CHECK (%s)', v_new_c); END IF;

    EXECUTE v_sql;

    INSERT INTO public.rls_hardening_log (
      run_id, batch, schemaname, tablename, policyname, cmd, roles,
      old_qual, old_with_check, new_qual, new_with_check
    ) VALUES (
      v_run_id, v_batch, r.schemaname, r.tablename, r.policyname, r.cmd, r.roles::text[],
      r.qual, r.with_check, v_new_q, v_new_c
    );

    v_total := v_total + 1;
    RAISE NOTICE 'Dichtgezet: %.% / % (%)', r.schemaname, r.tablename, r.policyname, r.cmd;
  END LOOP;

  RAISE NOTICE '--- klaar: % policies dichtgezet, run_id = % ---', v_total, v_run_id;
END
$do$;


-- ── 4) Wat is er aangepast? (lijst voor de PR) ──────────────────────────────
SELECT tablename, policyname, cmd, applied_at
FROM public.rls_hardening_log
WHERE batch = '2026-08-20-open-tables'
ORDER BY applied_at DESC, tablename, policyname;


-- ── 5) Restlek-check — hoort 0 rijen te geven ───────────────────────────────
SELECT p.tablename, p.policyname, p.cmd, p.roles, p.qual, p.with_check
FROM pg_policies p
WHERE p.schemaname = 'public'
  AND p.permissive = 'PERMISSIVE'
  AND (p.qual = 'true' OR p.with_check = 'true')
  AND p.roles = ARRAY['authenticated']::name[]
  AND (COALESCE(p.qual,'') || ' ' || COALESCE(p.with_check,'')) !~* 'is_crm_staff'
  AND p.tablename <> 'lms_students'
  AND p.tablename <> 'rls_hardening_log'
  AND p.tablename NOT LIKE 'lms\_%'
  AND p.tablename NOT LIKE 'hlms\_%'
ORDER BY p.tablename, p.policyname;
