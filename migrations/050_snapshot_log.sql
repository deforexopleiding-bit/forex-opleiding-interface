-- migrations/050_snapshot_log.sql
--
-- Logboek-snapshots (RFC 2 goedgekeurd design):
--   - snapshot_log-tabel = eigen tijdlijn-stream naast activity_log; correlatie
--     is soft (tijd + actor + action_hint), geen harde FK naar activity_log.
--   - Bijbehorende PRIVATE storage-bucket 'activity-snapshots' — service-role
--     schrijft; alleen super_admin leest via storage-RLS.
--
-- ⚠️  VOOR HET DRAAIEN — verify-first SELECT om storage-RLS-landschap te tonen:
--
--   select policyname, cmd, roles, qual, with_check
--   from pg_policies
--   where schemaname = 'storage' and tablename = 'objects';
--
--   -- Verwacht: alleen bucket-scoped policies (bv. sa_setups_obj_*).
--   -- Als je een policy ziet met qual = 'true' of zonder bucket_id-filter:
--   -- STOP — activity-snapshots zou lekken via die brede policy.
--   -- Als geen brede policies: veilig om deze migratie te draaien.
--
--   select policyname, cmd from pg_policies where tablename = 'snapshot_log';
--   select id, name, public from storage.buckets where id = 'activity-snapshots';
--   -- Beide: verwacht 0 rijen (nog niet aangemaakt).
--
-- Blast-radius: puur toevoegend. Geen wijziging aan bestaande tabellen/buckets.

begin;

-- ── 1) snapshot_log tabel ────────────────────────────────────────────────
create table if not exists snapshot_log (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete set null,
  user_email    text null,                    -- snapshot voor leesbaarheid (net als activity_log)
  captured_at   timestamptz not null default now(),
  view_url      text not null,                -- location.pathname + hash op moment van capture
  view_title    text null,                    -- document.title
  action_hint   text null,                    -- correlation-label; niet authoritative
  storage_path  text not null,                -- '{user_id}/{id}.webp' — verwijzing naar bucket
  size_kb       int null,
  ip            text null,
  user_agent    text null
);

create index if not exists idx_snapshot_log_user_captured
  on snapshot_log (user_id, captured_at desc);
create index if not exists idx_snapshot_log_captured_desc
  on snapshot_log (captured_at desc);

alter table snapshot_log enable row level security;

-- RLS: super_admin ziet alles; overige rollen alleen eigen rijen.
create policy snapshot_log_select_own on snapshot_log
  for select using (
    user_id = auth.uid()
    or exists (select 1 from profiles where id = auth.uid() and role = 'super_admin')
  );

-- ── 2) Private storage-bucket 'activity-snapshots' ──────────────────────
insert into storage.buckets (id, name, public)
values ('activity-snapshots', 'activity-snapshots', false)
on conflict (id) do nothing;

-- Storage-RLS: alleen SELECT-policy voor super_admin.
--
-- Bewuste keuze: GEEN _insert_none / _delete_none policies. RLS in Postgres
-- is permissive-OR — policies kunnen ALLEEN granten, niet weigeren. "None"-
-- policies zouden no-ops zijn en valse handhavings-suggestie geven.
--
-- Werkelijke afscherming voor niet-service-role users:
--   1. Bucket is private (public=false → geen publieke URL's).
--   2. Supabase-default op storage.objects = RLS ENABLED + geen granting-
--      policy = DEFAULT-DENY voor INSERT/DELETE.
--   3. Uploads gebeuren uitsluitend via /api/snapshot-log-upload (service-
--      role via supabaseAdmin — bypasst RLS).
--   4. Purge via cron-snapshot-cleanup — ook service-role.

drop policy if exists "activity_snapshots_select" on storage.objects;
create policy "activity_snapshots_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'activity-snapshots'
    and exists (select 1 from profiles where id = auth.uid() and role = 'super_admin')
  );

commit;

-- ── VERIFICATIE (draai los, na commit) ──────────────────────────────────
--
-- select count(*) from snapshot_log;                                       -- verwacht 0
-- select id, name, public from storage.buckets where id = 'activity-snapshots';
--                                                                          -- verwacht 1 rij, public=false
-- select policyname, cmd from pg_policies where tablename = 'snapshot_log';
--                                                                          -- verwacht: snapshot_log_select_own · SELECT
-- select policyname, cmd from pg_policies
--   where schemaname = 'storage' and policyname = 'activity_snapshots_select';
--                                                                          -- verwacht: 1 rij, SELECT-cmd
--
-- Rollback (defensief, alleen als bucket leeg):
--   delete from storage.buckets where id = 'activity-snapshots';
--   drop table if exists public.snapshot_log;
--   drop policy if exists "activity_snapshots_select" on storage.objects;
