-- 2026-06-07 — Finance Fase 4: sync_state uitbreiden met contacts + companies
--
-- Voegt twee extra resources aan sync_state toe voor de uitbreiding van
-- /api/cron-finance-sync (Fase 4). Seed-cursor 2025-01-01 zodat eerste runs
-- alle bestaande TL-contacten/companies binnenhalen.
--
-- Idempotent (ON CONFLICT DO NOTHING op resource-PK). Geen schema-wijziging:
-- sync_state.resource is TEXT PRIMARY KEY zonder CHECK-constraint (zie
-- 2026-06-06-finance-sync-state.sql), dus extra resources kunnen er direct in.

INSERT INTO sync_state (resource, last_updated_since)
VALUES
  ('contacts',  '2025-01-01T00:00:00+00:00'),
  ('companies', '2025-01-01T00:00:00+00:00')
ON CONFLICT (resource) DO NOTHING;

-- Verificatie:
-- SELECT resource, last_updated_since, last_run_at, last_run_processed
-- FROM sync_state ORDER BY resource;
-- Verwacht 4 rijen: contacts / companies / creditnotes / invoices.
