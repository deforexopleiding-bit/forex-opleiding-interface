-- Migratie 031 — Wanbetalers bulk-aanmaan wachtrij (Fase 1)
--
-- Twee tabellen als wachtrij + snapshot voor een bulk-aanmaan job. Fase 1
-- vult ze maar VERSTUURT NIETS: verzending komt in Fase 2 via cron die
-- approved jobs oppakt.
--
-- Idempotent (CREATE IF NOT EXISTS) — Jeffrey kan 'm veilig meerdere keren
-- draaien. pgcrypto voor gen_random_uuid() is al beschikbaar in ons project
-- (zie migraties 003-lisa-tables.sql en later).

-- Job = 1 rij per bulk-verzoek (Overzicht van wat de operator wil versturen).
create table if not exists dunning_bulk_jobs (
  id                  uuid primary key default gen_random_uuid(),
  created_by_user_id  uuid,
  channel             text not null check (channel in ('whatsapp','email','both')),
  template_name       text,             -- WhatsApp-template (naam in whatsapp_meta_templates)
  email_template_id   text,             -- Fase 3: emailkeuze; nu nullable placeholder
  status              text not null default 'draft' check (status in ('draft','approved','running','completed','cancelled')),
  total_recipients    int not null default 0,
  sent_count          int not null default 0,
  failed_count        int not null default 0,
  skipped_count       int not null default 0,
  batch_size          int not null default 10,
  created_at          timestamptz not null default now(),
  approved_at         timestamptz,
  completed_at        timestamptz
);

-- Recipients = 1 rij per klant in de job (snapshot van kanaal-eligibility,
-- ge-resolvede berichttekst, verzendresultaat). Fase 2 muteert status +
-- vult sent_at / wamid / error.
create table if not exists dunning_bulk_recipients (
  id                              uuid primary key default gen_random_uuid(),
  job_id                          uuid not null references dunning_bulk_jobs(id) on delete cascade,
  customer_id                     uuid,
  customer_name                   text,
  customer_email                  text,
  customer_phone                  text,
  invoice_ids                     jsonb,                     -- snapshot: open invoice-ids op moment van aanmaken
  total_open_cents                bigint not null default 0,
  open_invoice_count              int    not null default 0,
  channel_whatsapp                boolean not null default false,
  channel_email                   boolean not null default false,
  resolved_preview_whatsapp       text,                       -- ge-resolvede WA-body (audit + preview)
  resolved_preview_email_subject  text,
  resolved_preview_email_body     text,
  status                          text not null default 'pending' check (status in ('pending','sent','failed','skipped')),
  skip_reason                     text,                       -- 'no_phone' | 'no_email' | 'no_contact'
  wamid                           text,
  email_message_id                text,
  error                           text,
  sent_at                         timestamptz,
  created_at                      timestamptz not null default now()
);

create index if not exists idx_dunning_bulk_recipients_job_status
  on dunning_bulk_recipients (job_id, status);
create index if not exists idx_dunning_bulk_recipients_customer
  on dunning_bulk_recipients (customer_id);
create index if not exists idx_dunning_bulk_jobs_status_created
  on dunning_bulk_jobs (status, created_at desc);

notify pgrst, 'reload schema';
