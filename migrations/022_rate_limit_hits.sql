-- 022_rate_limit_hits.sql — generieke rate-limit-tabel (H3 security)
--
-- Elke publieke schrijf-endpoint schrijft één rij per verzoek. api/_lib/rate-limit.js
-- telt rijen binnen een tijdsvenster en weigert als de count boven de cap ligt.
--
-- Bucket = endpoint-naam (bv. 'assessment-register', 'onboarding-complete').
-- ip_hash = sha256(SUPABASE_URL + '|' + ip) truncated tot 32 hex chars (hergebruik
-- van hashIp() in api/_lib/assessment-validation.js). Geen raw IP's op disk.
--
-- Retentie: cron-activity-log-cleanup ruimt rijen > 1 dag op. Hits zijn na een
-- paar seconden al niet meer relevant voor de rate-limit-vensters (<= 60s).
--
-- Idempotent: veilig opnieuw te draaien (IF NOT EXISTS, DROP POLICY IF EXISTS).

create table if not exists rate_limit_hits (
  id           bigint generated always as identity primary key,
  bucket       text not null,
  ip_hash      text not null,
  created_at   timestamptz not null default now()
);

create index if not exists rate_limit_hits_lookup_idx
  on rate_limit_hits (bucket, ip_hash, created_at desc);

-- Extra index alleen op created_at voor de dagelijkse cleanup (bulk delete).
create index if not exists rate_limit_hits_created_at_idx
  on rate_limit_hits (created_at);

-- RLS AAN + default-deny voor client-rollen. Service-role bypasst RLS altijd,
-- dus de helper (met supabaseAdmin) schrijft/leest transparant. Client-lezen
-- heeft geen zin — dit is server-only telemetrie.
alter table rate_limit_hits enable row level security;

drop policy if exists "rate_limit_hits_no_client_read" on rate_limit_hits;

create policy "rate_limit_hits_no_client_read"
  on rate_limit_hits
  for select
  to authenticated, anon
  using (false);

notify pgrst, 'reload schema';
