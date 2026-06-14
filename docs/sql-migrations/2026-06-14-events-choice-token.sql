-- =============================================================================
-- 2026-06-14 — Fase 2a: choice_token op event_attendees + lookup-rate-limit log
-- =============================================================================
-- Doel:
--   1. Per deelnemer een unieke token-UUID waarmee een persoonlijke keuze-link
--      (zonder login) kan worden gebouwd: /modules/event-keuze.html?t=<token>
--   2. Een minimale rate-limit-state-tabel zodat het publieke read-only
--      endpoint /api/event-choice-get.js token-brute-force kan dichtknijpen.
--
-- Notes:
--   - gen_random_uuid() is op Supabase out-of-the-box beschikbaar (core sinds
--     PostgreSQL 13). Bestaande events-migraties gebruiken 'm al voor
--     event_attendees.id / event_signup_inbox.id / event_mentors.id — geen
--     extensie te installeren.
--   - Bestaande rijen krijgen via de DEFAULT-evaluatie elk een eigen token;
--     volatile gen_random_uuid() vuurt per rij, niet per ALTER-statement.
--     De UNIQUE-index zou bij een (theoretische) duplicate falen — in dat
--     onwaarschijnlijke geval moet de migratie opnieuw worden gerund.
--   - choice_token is NOT NULL met DEFAULT — toekomstige INSERTs zonder
--     expliciete waarde krijgen automatisch een token.
--
-- Rollback:
--   ALTER TABLE event_attendees DROP COLUMN choice_token;
--   DROP TABLE event_choice_lookup_log;
-- (Geen data-loss op event_attendees zelf; alleen het token-veld verdwijnt.)
-- =============================================================================

BEGIN;

-- ── 1. event_attendees.choice_token ───────────────────────────────────────────
ALTER TABLE public.event_attendees
  ADD COLUMN IF NOT EXISTS choice_token uuid NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS uq_event_attendees_choice_token
  ON public.event_attendees (choice_token);

-- ── 2. event_choice_lookup_log ────────────────────────────────────────────────
-- Doel: rate-limit state voor /api/event-choice-get (max N lookups per IP-hash
-- per tijdseenheid). Bewust GEEN personal data — alleen een gehashte IP +
-- timestamp. Token-waarde NIET opgeslagen om token-leak via logs te voorkomen.
CREATE TABLE IF NOT EXISTS public.event_choice_lookup_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_hash    text NOT NULL,
  lookup_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_choice_lookup_log_ip_recent
  ON public.event_choice_lookup_log (ip_hash, lookup_at DESC);

-- TTL housekeeping: rijen ouder dan 7 dagen mogen verwijderd worden door een
-- cron of handmatige cleanup. Geen automatische trigger; volstaat met
-- periodieke DELETE FROM event_choice_lookup_log WHERE lookup_at < now() - '7 days'.

ALTER TABLE public.event_choice_lookup_log ENABLE ROW LEVEL SECURITY;
-- Geen policies: service_role bypasset RLS. Endpoint schrijft via supabaseAdmin.

COMMIT;

-- =============================================================================
-- Smoke (handmatig na deploy):
-- =============================================================================
-- 1. Kolom + index aanwezig:
--    SELECT column_name, data_type, is_nullable
--    FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='event_attendees'
--      AND column_name='choice_token';
--    -- verwacht: uuid, NO.
--
--    SELECT indexname FROM pg_indexes
--    WHERE schemaname='public' AND tablename='event_attendees'
--      AND indexname='uq_event_attendees_choice_token';
--    -- verwacht: 1 rij.
--
-- 2. Alle bestaande rijen hebben unieke choice_token:
--    SELECT count(*) AS total,
--           count(DISTINCT choice_token) AS uniques,
--           count(*) FILTER (WHERE choice_token IS NULL) AS nulls
--    FROM event_attendees;
--    -- verwacht: total = uniques, nulls = 0.
--
-- 3. Lookup-tabel + index aanwezig + RLS aan:
--    SELECT count(*) FROM pg_tables
--    WHERE schemaname='public' AND tablename='event_choice_lookup_log';
--    -- verwacht: 1.
--
--    SELECT relname, relrowsecurity FROM pg_class
--    WHERE relname='event_choice_lookup_log';
--    -- verwacht: relrowsecurity=t.
