-- Migratie 037 — Incasso-module foundation (PR-1)
--
-- Twee nieuwe tabellen + permissie-grant. Jeffrey draait handmatig.
-- "Success. No rows returned" = normale uitkomst.
--
-- Idempotent (IF NOT EXISTS + ON CONFLICT).

-- ────────────────────────────────────────────────────────────────────
-- 1) dunning_incasso_bureaus — incasso-partners (NL + BE)
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.dunning_incasso_bureaus (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  email        text,
  country      text not null default 'NL' check (country in ('NL', 'BE')),
  address      text,
  notes        text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

create index if not exists idx_incasso_bureaus_active
  on public.dunning_incasso_bureaus (is_active) where is_active;

-- ────────────────────────────────────────────────────────────────────
-- 2) dunning_incasso_dossiers — 1 rij per aanmelding
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.dunning_incasso_dossiers (
  id             uuid primary key default gen_random_uuid(),
  customer_id    uuid not null references public.customers(id),
  bureau_id      uuid references public.dunning_incasso_bureaus(id),
  country        text not null default 'NL' check (country in ('NL', 'BE')),
  -- Status-lifecycle:
  --   aangemeld     → net aangemaakt, bureau nog niet actief bezig
  --   lopend        → bureau werkt aan het dossier
  --   betaald       → klant heeft betaald (terminal)
  --   afgeschreven  → oninbaar en afgeschreven (terminal)
  --   oninbaar      → officieel oninbaar (terminal)
  --   geretourneerd → bureau geeft dossier terug (terminal)
  status         text not null default 'aangemeld'
                 check (status in ('aangemeld','lopend','betaald','afgeschreven','oninbaar','geretourneerd')),
  debt_snapshot  jsonb not null default '{}'::jsonb,
  notes          text,
  pdf_ref        text,
  opened_by      uuid,
  opened_at      timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists idx_incasso_dossiers_customer
  on public.dunning_incasso_dossiers (customer_id);
create index if not exists idx_incasso_dossiers_status
  on public.dunning_incasso_dossiers (status);

-- ────────────────────────────────────────────────────────────────────
-- 3) RBAC — permissie 'finance.incasso.manage' voor admin/manager
--    super_admin bypasst via '*' (zie migratie 002).
-- ────────────────────────────────────────────────────────────────────
insert into public.role_permissions (role, feature_key, allowed) values
  ('admin',   'finance.incasso.manage', true),
  ('manager', 'finance.incasso.manage', true)
on conflict (role, feature_key) do update
  set allowed = excluded.allowed;

notify pgrst, 'reload schema';
