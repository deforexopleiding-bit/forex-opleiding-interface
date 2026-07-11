-- Migratie 036 — Wanbetalers-sandbox foundation
--
-- Jeffrey draait dit in de Supabase SQL-editor.
-- "Success. No rows returned" is de normale uitkomst.
--
-- Voegt is_test-vlaggen toe aan customers/invoices/dunning_bulk_jobs,
-- + partial indexen, + seed van de dry-run killswitch (default AAN).
-- Alles idempotent (IF NOT EXISTS / WHERE NOT EXISTS).

-- ────────────────────────────────────────────────────────────────────
-- 1) is_test-kolommen (default false — production-rijen blijven onaangetast)
-- ────────────────────────────────────────────────────────────────────
alter table public.customers
  add column if not exists is_test boolean not null default false;

alter table public.invoices
  add column if not exists is_test boolean not null default false;

-- dunning_bulk_jobs: markeer sandbox-jobs zodat de production-cron ze
-- overslaat en de sandbox-run ze wel kan draaien.
alter table public.dunning_bulk_jobs
  add column if not exists is_test boolean not null default false;

-- ────────────────────────────────────────────────────────────────────
-- 2) Partial indexen (klein; alleen op is_test=true rijen)
-- ────────────────────────────────────────────────────────────────────
create index if not exists idx_customers_is_test
  on public.customers (is_test) where is_test;

create index if not exists idx_invoices_is_test
  on public.invoices (is_test) where is_test;

create index if not exists idx_dunning_bulk_jobs_is_test
  on public.dunning_bulk_jobs (is_test) where is_test;

-- ────────────────────────────────────────────────────────────────────
-- 3) Dry-run killswitch — default AAN.
--    Zolang dunning_dry_run.value.enabled = true doen alle send-paden
--    (executeEmailStep, executeWhatsappStep, cron-dunning-bulk-send)
--    NIETS naar Meta/SMTP; ze loggen alleen wat ze GEZONDEN zouden hebben.
-- ────────────────────────────────────────────────────────────────────
insert into public.app_settings (key, value)
select 'dunning_dry_run', jsonb_build_object('enabled', true)
where not exists (
  select 1 from public.app_settings where key = 'dunning_dry_run'
);

-- ────────────────────────────────────────────────────────────────────
-- 4) Sandbox-contact — {phone, email} van de test-persoon. Recipient-guard
--    controleert vlak vóór een ECHTE verzending dat het doel-nummer/-mail
--    hiermee overeenkomt (zelfs als dry_run uit staat). Voorkomt dat een
--    test-send per ongeluk naar een echte klant lekt.
-- ────────────────────────────────────────────────────────────────────
insert into public.app_settings (key, value)
select 'dunning_sandbox_contact', jsonb_build_object('phone', null, 'email', null)
where not exists (
  select 1 from public.app_settings where key = 'dunning_sandbox_contact'
);

notify pgrst, 'reload schema';
