-- 2026-10-26-weekeditie-lancering.sql
-- Contentmachine 2.0, fase 5: "Keur goed en lanceer".
-- ADDITIEF: drie nieuwe tabellen, geen bestaande tabel of recht gewijzigd.
-- RLS aan + REVOKE, geen policies: alleen de service role (API na content.machine).
--
--   weekeditie_testmails            — testmail naar de ingelogde gebruiker per drop-versie
--                                     (zonder geslaagde test van deze versie geen lancering)
--   weekeditie_lanceringen          — één lancering per drop (nu of ingepland), met de
--                                     tag-voortgang (getagd X van Y) en de paginacontrole
--   weekeditie_lancering_contacten  — elk GHL-contact hoogstens één keer per lancering
--                                     (eerst claimen, dan taggen: nooit dubbel een mail)

create table if not exists public.weekeditie_testmails (
  id uuid primary key default gen_random_uuid(),
  drop_id uuid not null references public.content_drops(id) on delete cascade,
  drop_versie integer not null,
  onderwerp_index integer not null default 0,
  email text not null,
  verstuurd_door uuid,
  verstuurd_op timestamptz not null default now()
);
create index if not exists weekeditie_testmails_drop_idx on public.weekeditie_testmails (drop_id, drop_versie);

create table if not exists public.weekeditie_lanceringen (
  id uuid primary key default gen_random_uuid(),
  drop_id uuid not null references public.content_drops(id) on delete cascade,
  drop_versie integer not null,
  status text not null default 'ingepland'
    check (status in ('ingepland', 'taggen', 'klaar', 'geannuleerd', 'mislukt')),
  modus text not null check (modus in ('nu', 'ingepland')),
  ingepland_op timestamptz,
  onderwerp text,
  onderwerp_index integer not null default 0,
  doelgroep_tag text not null,
  verzend_tag text not null,
  template_id text,
  totaal integer,
  getagd integer not null default 0,
  overgeslagen integer not null default 0,
  mislukt integer not null default 0,
  cursor jsonb,
  pagina_check jsonb,
  fout text,
  gestart_op timestamptz,
  klaar_op timestamptz,
  aangemaakt_door uuid,
  aangemaakt_op timestamptz not null default now(),
  gewijzigd_op timestamptz not null default now()
);
create index if not exists weekeditie_lanceringen_drop_idx on public.weekeditie_lanceringen (drop_id, aangemaakt_op desc);
create index if not exists weekeditie_lanceringen_status_idx on public.weekeditie_lanceringen (status, ingepland_op);
-- hoogstens één lopende lancering per drop
create unique index if not exists weekeditie_lanceringen_een_actief
  on public.weekeditie_lanceringen (drop_id) where status in ('ingepland', 'taggen');

create table if not exists public.weekeditie_lancering_contacten (
  lancering_id uuid not null references public.weekeditie_lanceringen(id) on delete cascade,
  contact_id text not null,
  status text not null check (status in ('bezig', 'getagd', 'overgeslagen', 'mislukt')),
  reden text,
  op timestamptz not null default now(),
  primary key (lancering_id, contact_id)
);

alter table public.weekeditie_testmails enable row level security;
alter table public.weekeditie_lanceringen enable row level security;
alter table public.weekeditie_lancering_contacten enable row level security;
revoke all on public.weekeditie_testmails from anon, authenticated;
revoke all on public.weekeditie_lanceringen from anon, authenticated;
revoke all on public.weekeditie_lancering_contacten from anon, authenticated;
