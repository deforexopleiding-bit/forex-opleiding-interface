-- 2026-09-04 · Afspraak-reminders — Fase A fundament
--
-- CONTEXT
-- Fundament voor de in-house call-bevestiging + reminders (additief). Voegt
-- guard-/status-kolommen toe aan public.follow_up_appointments zodat de nieuwe
-- cron (api/cron-afspraak-reminders.js) per afspraak kan bijhouden welke
-- berichten al verstuurd zijn, of de lead heeft bevestigd, en een getokende
-- self-service-link (verzetten/annuleren) kan opbouwen.
--
-- SCOPE / AFBLIJVEN
--   - Raakt ALLEEN public.follow_up_appointments (kolommen toevoegen).
--   - 7-daagse, mini-cursus en public.toegang_aanvragen (cron-toegang-aanvragen)
--     blijven 100% ongemoeid. GHL blijft de Zoom/agenda-motor.
--   - 0 incasso-writes.
--
-- KOLOMMEN
--   bevestiging_sent_at  timestamptz  — guard: bevestiging (mail+WA) verstuurd
--   reminder_24u_at      timestamptz  — guard: 24u-reminder verstuurd
--   reminder_2u_at       timestamptz  — guard: 2u-reminder (quick-reply) verstuurd
--   reminder_30m_at      timestamptz  — guard: 30m-reminder verstuurd
--   zoom_5min_at         timestamptz  — guard: 5-min join-bericht verstuurd
--   bevestigd_at         timestamptz  — gezet als lead "Ik ben erbij" tikt →
--                                       onderdrukt de 30m-reminder
--   afspraak_token       uuid         — self-service-token (verzetten/annuleren),
--                                       DEFAULT gen_random_uuid() vult ook
--                                       bestaande rijen (per-rij uniek).
--
--   Eén timestamp per moment dekt mail+WA samen. Splitsen naar _mail_at/_wa_at
--   kan later; nu niet nodig.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS +
--             backfill met WHERE ... IS NULL. Veilig om opnieuw te draaien.

BEGIN;

-- ── A. Guard-/status-kolommen ──────────────────────────────────────────────
ALTER TABLE public.follow_up_appointments
  ADD COLUMN IF NOT EXISTS bevestiging_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_24u_at     timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_2u_at      timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_30m_at     timestamptz,
  ADD COLUMN IF NOT EXISTS zoom_5min_at        timestamptz,
  ADD COLUMN IF NOT EXISTS bevestigd_at        timestamptz;

COMMENT ON COLUMN public.follow_up_appointments.bevestiging_sent_at IS
  'Afspraak-reminders: bevestiging (mail+WA) verstuurd. NULL = nog niet.';
COMMENT ON COLUMN public.follow_up_appointments.bevestigd_at IS
  'Afspraak-reminders: lead bevestigde met quick-reply "Ik ben erbij". Onderdrukt de 30m-reminder.';

-- ── B. Self-service-token ──────────────────────────────────────────────────
-- DEFAULT gen_random_uuid() vult bestaande rijen meteen (per-rij uniek) én
-- nieuwe rijen automatisch. Zelfde functie als de id-default van deze tabel.
ALTER TABLE public.follow_up_appointments
  ADD COLUMN IF NOT EXISTS afspraak_token uuid DEFAULT gen_random_uuid();

-- Backfill-vangnet: mocht de kolom in een eerdere (partiële) run zonder default
-- zijn toegevoegd, dan alsnog een token zetten voor rijen die er geen hebben.
UPDATE public.follow_up_appointments
   SET afspraak_token = gen_random_uuid()
 WHERE afspraak_token IS NULL;

COMMENT ON COLUMN public.follow_up_appointments.afspraak_token IS
  'Ongokbaar self-service-token (verzetten/annuleren via publieke pagina). Server-side resolven; nooit appointment_id in de URL.';

-- ── C. Indexen ─────────────────────────────────────────────────────────────
-- Uniek token (lookup + veiligheid tegen botsingen).
CREATE UNIQUE INDEX IF NOT EXISTS idx_fu_appointments_afspraak_token
  ON public.follow_up_appointments (afspraak_token);

-- Cron-scan: alleen geplande afspraken op scheduled_at.
CREATE INDEX IF NOT EXISTS idx_fu_appointments_scheduled_open
  ON public.follow_up_appointments (scheduled_at)
  WHERE status = 'scheduled';

COMMIT;

-- ============================================================================
-- VERIFICATIE (draai NA COMMIT)
-- ============================================================================
--   SELECT column_name, data_type, column_default
--     FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='follow_up_appointments'
--      AND column_name IN ('bevestiging_sent_at','reminder_24u_at','reminder_2u_at',
--                          'reminder_30m_at','zoom_5min_at','bevestigd_at','afspraak_token')
--    ORDER BY column_name;
--   Verwacht: 7 kolommen; afspraak_token met default gen_random_uuid().
--
--   SELECT count(*) AS zonder_token
--     FROM public.follow_up_appointments WHERE afspraak_token IS NULL;
--   Verwacht: 0.
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
--   ALTER TABLE public.follow_up_appointments
--     DROP COLUMN IF EXISTS bevestiging_sent_at,
--     DROP COLUMN IF EXISTS reminder_24u_at,
--     DROP COLUMN IF EXISTS reminder_2u_at,
--     DROP COLUMN IF EXISTS reminder_30m_at,
--     DROP COLUMN IF EXISTS zoom_5min_at,
--     DROP COLUMN IF EXISTS bevestigd_at,
--     DROP COLUMN IF EXISTS afspraak_token;
--   DROP INDEX IF EXISTS public.idx_fu_appointments_afspraak_token;
--   DROP INDEX IF EXISTS public.idx_fu_appointments_scheduled_open;
-- ============================================================================
