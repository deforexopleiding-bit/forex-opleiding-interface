-- 2026-08-17-leadsonderhoud-bulk-schema.sql
--
-- FASE 3 leadsonderhoud-bulk: schema voor bulk-broadcast (WA + mail) naar
-- lead-segmenten. Spiegelt dunning_bulk_jobs/_recipients (dunning-precedent,
-- api/cron-dunning-bulk-send.js) met leadsonderhoud-specifieke keys:
--   - Sleutel is lead_id (uuid), niet customer_id.
--   - Extra segment-jsonb voor audit + herhaal-baarheid van de filterset.
--   - Verplichte test-send-guard (test_sent_at NOT NULL vereist vóór approve
--     kan slagen — enforcement in api/leadsonderhoud-bulk-approve.js).
--   - hard_cap=500 default (product-keuze; dunning was 200).
--
-- Draai deze migratie in Supabase VÓÓR de bulk-endpoints ge-hit worden. De
-- backend-code is fail-soft en returnt duidelijke 500-fout tot de tabellen
-- bestaan.

CREATE TABLE IF NOT EXISTS leadsonderhoud_bulk_jobs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by_user_id     uuid NOT NULL REFERENCES auth.users(id),
  channel                text NOT NULL CHECK (channel IN ('whatsapp','email','both')),
  template_name          text,
  template_language      text DEFAULT 'nl',
  email_subject          text,
  email_body             text,
  segment                jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                 text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','running','completed','cancelled')),
  total_recipients       integer NOT NULL DEFAULT 0,
  skipped_count          integer NOT NULL DEFAULT 0,
  sent_count             integer NOT NULL DEFAULT 0,
  failed_count           integer NOT NULL DEFAULT 0,
  batch_size             integer NOT NULL DEFAULT 10,
  hard_cap               integer NOT NULL DEFAULT 500,
  is_test                boolean NOT NULL DEFAULT false,
  test_sent_at           timestamptz,
  test_target            text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  approved_at            timestamptz,
  approved_by_user_id    uuid REFERENCES auth.users(id),
  completed_at           timestamptz,
  cancelled_at           timestamptz
);

CREATE INDEX IF NOT EXISTS idx_ls_bulk_jobs_status_created
  ON leadsonderhoud_bulk_jobs (status, created_at);

CREATE TABLE IF NOT EXISTS leadsonderhoud_bulk_recipients (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                          uuid NOT NULL REFERENCES leadsonderhoud_bulk_jobs(id) ON DELETE CASCADE,
  lead_id                         uuid NOT NULL,
  lead_naam                       text,
  traject                         text,
  phone                           text,
  email                           text,
  channel_whatsapp                boolean NOT NULL DEFAULT false,
  channel_email                   boolean NOT NULL DEFAULT false,
  needs_template                  boolean NOT NULL DEFAULT false,
  resolved_preview_wa             text,
  resolved_preview_email_subject  text,
  resolved_preview_email_body     text,
  status                          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','skipped','cancelled')),
  skip_reason                     text,
  wamid                           text,
  sent_at                         timestamptz,
  failed_reason                   text,
  retry_count                     integer NOT NULL DEFAULT 0,
  created_at                      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ls_bulk_recipients_job_status
  ON leadsonderhoud_bulk_recipients (job_id, status);
CREATE INDEX IF NOT EXISTS idx_ls_bulk_recipients_lead
  ON leadsonderhoud_bulk_recipients (lead_id);

-- RLS: writes gaan via service_role (endpoints); reads eveneens (endpoints
-- filteren op created_by_user_id waar zinvol). Voor consistentie enable +
-- deny-all, spiegel van andere leadsonderhoud-tabellen.
ALTER TABLE leadsonderhoud_bulk_jobs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE leadsonderhoud_bulk_recipients ENABLE ROW LEVEL SECURITY;
-- Geen policies = deny-all voor authenticated; service_role bypasst RLS.
