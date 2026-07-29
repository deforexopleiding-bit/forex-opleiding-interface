-- 2026-07-29-dunning-hung-runs-reset.sql
--
-- FIX 1 (draai NA de merge van 2026-07-29-dunning-run-retry-attention-columns.sql).
--
-- Reset alle active dunning-runs die met een next_action_at in het verleden
-- zijn blijven hangen (>1 dag oud). De cron heeft ze niet opgepakt door
-- combinatie van:
--   * pending_actions-guard (#888) die de run skipt als er open
--     verify/manual-taken staan (fix: bulk-reject van 44 orphan-taken).
--   * dag7-template die faalde met Meta 132000 (fix: dag7-body restore).
--
-- Deze migratie zet die runs terug in de rij (next_action_at = now()) zodat
-- de eerstvolgende cron-tick ze weer probeert. Runs die inmiddels op
-- needs_attention=true staan (fix 2) worden expliciet OVERGESLAGEN — die
-- vragen menselijke actie voor ze weer mogen draaien.
--
-- Transactie met pre/post-count zodat je in de SQL-editor-output ziet
-- hoeveel runs geraakt zijn. Rollback = ROLLBACK; in plaats van COMMIT.
-- Idempotent — een tweede run raakt niets meer omdat next_action_at nu
-- niet meer >1 dag oud is.

BEGIN;

  -- PRE-count: hoeveel runs komen in aanmerking?
  DO $$
  DECLARE
    v_pre_count int;
  BEGIN
    SELECT COUNT(*) INTO v_pre_count
    FROM dunning_workflow_runs
    WHERE status = 'active'
      AND paused_by_conversation_id IS NULL
      AND paused_by_arrangement_id  IS NULL
      AND next_action_at IS NOT NULL
      AND next_action_at < NOW() - INTERVAL '1 day'
      AND (needs_attention IS NULL OR needs_attention = false);

    RAISE NOTICE 'PRE-count hung runs (>1d verlopen, geen pauze, geen needs_attention): %', v_pre_count;
  END $$;

  -- Reset — schuif next_action_at naar nu.
  -- Belangrijk: needs_attention-runs worden bewust NIET meegeteld; die
  -- staan op de escalate-tak van de nieuwe retry-logica en moeten door
  -- een mens vrijgegeven worden (via UI-actie of directe SQL).
  UPDATE dunning_workflow_runs
  SET next_action_at = NOW(),
      updated_at     = NOW()
  WHERE status = 'active'
    AND paused_by_conversation_id IS NULL
    AND paused_by_arrangement_id  IS NULL
    AND next_action_at IS NOT NULL
    AND next_action_at < NOW() - INTERVAL '1 day'
    AND (needs_attention IS NULL OR needs_attention = false);

  -- POST-count: hoeveel staan er nu klaar voor de eerstvolgende cron?
  DO $$
  DECLARE
    v_ready int;
  BEGIN
    SELECT COUNT(*) INTO v_ready
    FROM dunning_workflow_runs
    WHERE status = 'active'
      AND paused_by_conversation_id IS NULL
      AND paused_by_arrangement_id  IS NULL
      AND next_action_at IS NOT NULL
      AND next_action_at <= NOW();

    RAISE NOTICE 'POST-count runs met next_action_at <= NOW() (klaar voor cron): %', v_ready;
  END $$;

  -- Audit-spoor: log de reset in dunning_log per run zodat het
  -- terug te vinden is in de klant-timeline. Gebruikt dezelfde
  -- run_id én current_step_id die de run heeft; event-type =
  -- 'hung_run_reset' met de vorige next_action_at in payload.
  INSERT INTO dunning_log (run_id, step_id, event_type, payload, created_at)
  SELECT
    r.id,
    r.current_step_id,
    'hung_run_reset',
    jsonb_build_object(
      'reset_at',         NOW(),
      'reason',           'admin-triggered fix 1 — cron liet runs hangen',
      'migration',        '2026-07-29-dunning-hung-runs-reset.sql'
    ),
    NOW()
  FROM dunning_workflow_runs r
  WHERE r.status = 'active'
    AND r.paused_by_conversation_id IS NULL
    AND r.paused_by_arrangement_id  IS NULL
    AND r.next_action_at IS NOT NULL
    AND r.updated_at > NOW() - INTERVAL '10 seconds'  -- alleen zojuist geraakte rijen
    AND (r.needs_attention IS NULL OR r.needs_attention = false);

COMMIT;

-- ROLLBACK-instructie:
-- Als de POST-count onverwacht is (bv. >100 runs voor een cron die 26 zou
-- moeten oppakken), sluit de transactie NIET af met COMMIT maar met
-- ROLLBACK. De update is dan volledig teruggedraaid.
