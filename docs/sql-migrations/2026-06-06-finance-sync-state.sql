-- 2026-06-06 — Finance cron-sync state
--
-- Houdt per resource (invoices, creditnotes) de cursor + run-statistieken bij voor
-- /api/cron-finance-sync. Idempotente migratie (CREATE IF NOT EXISTS + ON CONFLICT
-- DO NOTHING op de seed). Veilig om meerdere keren te draaien.
--
-- Seed-cursor 2026-06-01 zodat de eerste cron-run het gat 2026/1081+ binnenhaalt
-- (laatste handmatige sync stopte rond 2026/1080).

CREATE TABLE IF NOT EXISTS sync_state (
  resource              TEXT PRIMARY KEY,                 -- 'invoices' | 'creditnotes'
  last_updated_since    TIMESTAMPTZ NOT NULL,             -- cursor voor volgende run
  last_run_at           TIMESTAMPTZ,                      -- wanneer de laatste run startte
  last_run_processed    INT DEFAULT 0,                    -- hoeveel records verwerkt
  last_run_errors       INT DEFAULT 0,                    -- hoeveel records failden
  last_run_duration_ms  INT,                              -- run-duur (ms)
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed cursors. ON CONFLICT DO NOTHING beschermt bestaande rijen bij her-run.
INSERT INTO sync_state (resource, last_updated_since)
VALUES
  ('invoices',    '2026-06-01T00:00:00+00:00'),
  ('creditnotes', '2026-06-01T00:00:00+00:00')
ON CONFLICT (resource) DO NOTHING;

-- updated_at-trigger (consistent met andere finance-tabellen).
CREATE OR REPLACE FUNCTION sync_state_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_state_touch ON sync_state;
CREATE TRIGGER trg_sync_state_touch
  BEFORE UPDATE ON sync_state
  FOR EACH ROW EXECUTE FUNCTION sync_state_touch_updated_at();

-- RLS: sync_state is alleen voor server-side service_role (cron + status-endpoint
-- gebruiken supabaseAdmin). Geen authenticated-read nodig — UI vraagt via
-- /api/finance-sync-status (server-side).
ALTER TABLE sync_state ENABLE ROW LEVEL SECURITY;
-- Geen policy = geen toegang voor authenticated/anon. Service-role bypasses RLS.
