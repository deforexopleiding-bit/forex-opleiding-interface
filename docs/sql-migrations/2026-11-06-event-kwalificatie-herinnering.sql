-- 2026-11-06 · Guard-kolommen voor de eenmalige EVENT-aanmelding-herinnering (fase 1, e-mail).
--
-- Doel: iemand die in de event-funnel zijn gegevens achterliet
-- (event_kwalificatie_submissions, resultaat='toegelaten') maar GEEN plek boekte
-- (attendee_id IS NULL, geen event_attendees-rij) krijgt EENMALIG een
-- herinnerings-e-mail van api/cron-event-herinnering.js. Deze kolommen vormen de
-- submission-scoped dedup/claim (event_attendee_comms_log is attendee-scoped en
-- dus onbruikbaar voor afhakers zonder attendee).
--
-- Kolommen:
--   herinnering_sent_at   - atomic claim + "verstuurd op" (NULL = nog niet geclaimd)
--   herinnering_kanalen   - jsonb met de uitkomst per kanaal, bv.
--                           { "email": { "ok": true, "at": "...", "message_id": "..." } }
--                           of { "skipped": "reeds_geboekt" }
--   herinnering_pogingen  - aantal verzend-pogingen (voor de retry-cap)
--   herinnering_gaveup_at - opgegeven na de cap of bij een definitieve skip
--
-- Idempotent (add column if not exists). Handmatig te draaien.

alter table public.event_kwalificatie_submissions
  add column if not exists herinnering_sent_at    timestamptz,
  add column if not exists herinnering_kanalen     jsonb,
  add column if not exists herinnering_pogingen    integer not null default 0,
  add column if not exists herinnering_gaveup_at   timestamptz;

-- Smalle index voor de cron-selectie: alleen nog-niet-herinnerde, niet-geboekte,
-- toegelaten inzendingen, gesorteerd op created_at (het venster van de cron).
create index if not exists idx_eks_herinnering_open
  on public.event_kwalificatie_submissions (created_at)
  where herinnering_sent_at is null
    and herinnering_gaveup_at is null
    and attendee_id is null
    and resultaat = 'toegelaten';

notify pgrst, 'reload schema';
