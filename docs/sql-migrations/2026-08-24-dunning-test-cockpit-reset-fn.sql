-- 2026-08-24 · Dunning Test Cockpit — reset RPC-functie (BLOK 1 · PR-cockpit-eps).
-- HARDENING · 2026-08-25 (revisie 3):
--   1. invoice-delete op (customer_id ANY OR is_test=true) — vangt orphan-
--      is_test-facturen én test-klant-facturen met is_test=false.
--   2. dunning_incasso_dossiers + onboardings expliciet toegevoegd — twee
--      no-action/restrict FK's naar customers die de customers-delete
--      blokkeerden.
--
-- FK-volgorde bewust:
--   1. pending_actions               (customer_id)
--   2. dunning_workflow_runs         (customer_id)
--   3. payment_arrangements          (customer_id)
--   4. payment_promises              (customer_id)
--   5. dunning_briefs                (customer_id)
--   6. dunning_pipeline_customers    (customer_id)
--   7. deals                         (customer_id)
--   8. dunning_trajectories/letters/avg_data_requests  (customer_id)
--   9. dunning_incasso_dossiers      (customer_id)   ← revisie 3
--  10. onboardings                   (customer_id)   ← revisie 3
--  11. invoices                      (customer_id ANY OR is_test=true)
--  12. whatsapp_messages             (via test-conv_ids)
--  13. whatsapp_conversations        (is_test=true OR customer_id ANY)
--  14. email_messages                (customer_id-scoped)
--  15. customers                     (is_test=true)
--
-- ELKE nieuwe restrict/no-action FK naar customers hier toevoegen —
-- CASCADE-FK's hoeven niet, die worden bij customers-delete automatisch
-- meegenomen door PostgreSQL.
--
-- Bij dry_run=true → alleen tellingen, geen deletes.
-- Bij dry_run=false → deletes in transactie. Bij FK-fout: PostgreSQL rolt
--   automatisch terug (functie throw't); geen half-geleegde state mogelijk.
--
-- Idempotent + super_admin-only enforced door de aanroepende API (server-side).

BEGIN;

CREATE OR REPLACE FUNCTION public.dunning_test_cockpit_reset(p_dry_run boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_test_customer_ids uuid[];
  v_test_invoice_ids  uuid[];
  v_test_run_ids      uuid[];
  v_test_conv_ids     uuid[];

  v_counts jsonb;
BEGIN
  -- Verzamel scope-IDs (fail-safe: NULL wordt array[])
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_test_customer_ids
    FROM customers WHERE is_test = true;

  -- invoice-scope volgt de delete-scope (revisie 1: OR is_test=true).
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_test_invoice_ids
    FROM invoices
   WHERE is_test = true
      OR customer_id = ANY(v_test_customer_ids);

  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_test_run_ids
    FROM dunning_workflow_runs
   WHERE customer_id = ANY(v_test_customer_ids);
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_test_conv_ids
    FROM whatsapp_conversations
   WHERE is_test = true
      OR customer_id = ANY(v_test_customer_ids);

  -- Tellingen (voor zowel dry-run als bevestiging)
  v_counts := jsonb_build_object(
    'customers',              array_length(v_test_customer_ids, 1),
    'invoices',               array_length(v_test_invoice_ids, 1),
    'dunning_workflow_runs',  array_length(v_test_run_ids, 1),
    'whatsapp_conversations', array_length(v_test_conv_ids, 1)
  );

  IF p_dry_run THEN
    RETURN jsonb_build_object(
      'dry_run', true,
      'counts',  v_counts,
      'message', 'Dry-run — nog niets verwijderd. Roep opnieuw aan met dry_run=false om te wissen.'
    );
  END IF;

  -- ── ACTUAL DELETE in dezelfde transactie ─────────────────────────────────
  IF array_length(v_test_customer_ids, 1) IS NULL THEN
    RETURN jsonb_build_object(
      'dry_run', false,
      'counts',  v_counts,
      'message', 'Geen is_test-data gevonden — niets verwijderd.'
    );
  END IF;

  -- 1. pending_actions (CASCADE, maar expliciet voor deterministisch gedrag)
  DELETE FROM pending_actions WHERE customer_id = ANY(v_test_customer_ids);

  -- 2. dunning_workflow_runs (CASCADE via customer_id, expliciet)
  DELETE FROM dunning_workflow_runs WHERE customer_id = ANY(v_test_customer_ids);

  -- 3. payment_arrangements (RESTRICT — expliciet weg)
  DELETE FROM payment_arrangements WHERE customer_id = ANY(v_test_customer_ids);

  -- 4. payment_promises (RESTRICT)
  DELETE FROM payment_promises WHERE customer_id = ANY(v_test_customer_ids);

  -- 5. dunning_briefs (RESTRICT)
  DELETE FROM dunning_briefs WHERE customer_id = ANY(v_test_customer_ids);

  -- 6. dunning_pipeline_customers (safety-cleanup, kan CASCADE of RESTRICT zijn)
  BEGIN
    DELETE FROM dunning_pipeline_customers WHERE customer_id = ANY(v_test_customer_ids);
  EXCEPTION WHEN undefined_table THEN
    NULL; -- Tabel bestaat mogelijk niet in alle envs
  END;

  -- 7. deals (RESTRICT — sandbox-seed maakt een regeling-deal)
  BEGIN
    DELETE FROM deals WHERE customer_id = ANY(v_test_customer_ids);
  EXCEPTION WHEN undefined_table THEN
    NULL;
  END;

  -- 8. dunning_trajectories, letters, avg_data_requests (RESTRICT catch-all)
  BEGIN
    DELETE FROM dunning_trajectories WHERE customer_id = ANY(v_test_customer_ids);
  EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN
    DELETE FROM letters WHERE customer_id = ANY(v_test_customer_ids);
  EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN
    DELETE FROM avg_data_requests WHERE customer_id = ANY(v_test_customer_ids);
  EXCEPTION WHEN undefined_table THEN NULL; END;

  -- 9. dunning_incasso_dossiers (NO ACTION — moet vóór customer)
  --    Revisie 3: toegevoegd na FK-lijst-scan. env-veilige wrapper zodat
  --    deploys naar envs zonder deze tabel niet breken.
  --    ⚠ ELKE nieuwe restrict/no-action FK naar customers hier toevoegen.
  BEGIN
    DELETE FROM dunning_incasso_dossiers WHERE customer_id = ANY(v_test_customer_ids);
  EXCEPTION WHEN undefined_table THEN NULL; END;

  -- 10. onboardings (RESTRICT — moet vóór customer)
  --     Revisie 3: toegevoegd na FK-lijst-scan.
  BEGIN
    DELETE FROM onboardings WHERE customer_id = ANY(v_test_customer_ids);
  EXCEPTION WHEN undefined_table THEN NULL; END;

  -- 11. invoices (RESTRICT — moet vóór customer)
  --     Revisie 1: eerst customer_id-scope (alle facturen van test-klanten,
  --     ook die met is_test=false), daarna is_test=true (orphan-invoices
  --     waarvan de klant al weg is). OR combineert beide takken in één DELETE.
  --     Geen enkele niet-test-klant kan geraakt worden.
  DELETE FROM invoices
   WHERE customer_id = ANY(v_test_customer_ids)
      OR is_test = true;

  -- 12. whatsapp_messages via conversation_id (SET NULL, expliciet cleared)
  DELETE FROM whatsapp_messages WHERE conversation_id = ANY(v_test_conv_ids);

  -- 13. whatsapp_conversations (is_test=true of test-customer koppeling)
  DELETE FROM whatsapp_conversations
   WHERE is_test = true
      OR customer_id = ANY(v_test_customer_ids);

  -- 14. email_messages — cockpit-simulate e-mail-tak koppelt customer_id
  --     expliciet op elke fake reply-mail (wanbetalers-sandbox-simulate-
  --     inbound.js channel='email'). Consistent met teardown-helper.
  --     NOOIT wissen op from_address — kan productie-mails van dezelfde
  --     afzender raken.
  DELETE FROM email_messages WHERE customer_id = ANY(v_test_customer_ids);

  -- 15. Ten slotte: customers (is_test=true)
  DELETE FROM customers WHERE is_test = true;

  RETURN jsonb_build_object(
    'dry_run', false,
    'counts',  v_counts,
    'message', 'Reset voltooid — alle is_test-data verwijderd in één transactie.'
  );
END;
$fn$;

-- SECURITY DEFINER: functie draait met eigenaar-rechten (postgres/supabase_admin).
-- Endpoint dat 'em aanroept is super_admin-gated (server-side); RPC blokkeert
-- geen extra rol-check omdat de aanroeper via supabaseAdmin gaat.
GRANT EXECUTE ON FUNCTION public.dunning_test_cockpit_reset(boolean) TO service_role;
REVOKE EXECUTE ON FUNCTION public.dunning_test_cockpit_reset(boolean) FROM public;
REVOKE EXECUTE ON FUNCTION public.dunning_test_cockpit_reset(boolean) FROM anon;
REVOKE EXECUTE ON FUNCTION public.dunning_test_cockpit_reset(boolean) FROM authenticated;

DO $$
BEGIN
  RAISE NOTICE '── dunning_test_cockpit_reset() aangemaakt (revisie 3) ──────';
  RAISE NOTICE '  Aanroep: SELECT public.dunning_test_cockpit_reset(true);   -- dry-run';
  RAISE NOTICE '           SELECT public.dunning_test_cockpit_reset(false);  -- ACTUAL delete';
END $$;

COMMIT;
