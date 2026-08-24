-- 2026-08-24 · Dunning Test Cockpit — reset RPC-functie (BLOK 1 · PR-cockpit-eps).
--
-- dunning_test_cockpit_reset(p_dry_run boolean) → jsonb
--
-- Één transactie die alle is_test=true rijen uit de dunning-test-scope wist.
-- FK-volgorde bewust:
--   1. pending_actions (CASCADE via customer_id — expliciet voor telling)
--   2. dunning_workflow_runs (CASCADE — expliciet voor telling)
--   3. payment_arrangements (RESTRICT)
--   4. payment_promises (RESTRICT)
--   5. dunning_briefs (RESTRICT)
--   6. dunning_pipeline_customers (RESTRICT/CASCADE — expliciet voor safety)
--   7. deals (RESTRICT — sandbox-seed maakt regeling-deal)
--   8. invoices (RESTRICT — moet vóór customer)
--   9. whatsapp_conversations (is_test=true — SET NULL op customer_id)
--  10. whatsapp_messages via conversation_id (SET NULL — expliciet gecleared)
--  11. customers (is_test=true)
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
SET search_path = public
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
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_test_invoice_ids
    FROM invoices WHERE is_test = true;
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

  -- 9. invoices (RESTRICT — moet vóór customer)
  DELETE FROM invoices WHERE is_test = true;

  -- 10. whatsapp_messages via conversation_id (SET NULL, expliciet cleared)
  DELETE FROM whatsapp_messages WHERE conversation_id = ANY(v_test_conv_ids);

  -- 11. whatsapp_conversations (is_test=true of test-customer koppeling)
  DELETE FROM whatsapp_conversations
   WHERE is_test = true
      OR customer_id = ANY(v_test_customer_ids);

  -- 12. Ten slotte: customers (is_test=true)
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
  RAISE NOTICE '── dunning_test_cockpit_reset() aangemaakt ─────────────────';
  RAISE NOTICE '  Aanroep: SELECT public.dunning_test_cockpit_reset(true);   -- dry-run';
  RAISE NOTICE '           SELECT public.dunning_test_cockpit_reset(false);  -- ACTUAL delete';
END $$;

COMMIT;
