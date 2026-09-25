-- 2026-09-24 · afspraak-berichten: retry-cap + onbezorgbaar-marker.
--
-- ⚠ BLOKKEREND — MOET DRAAIEN VÓÓR de merge van de begeleidende PR.
-- cron-afspraak-reminders selecteert deze kolommen bij naam. Zonder deze
-- migratie faalt ELKE run van de reminder-cron met `column ... does not exist`
-- → geen enkele bevestiging of reminder (24u/2u/30m/5min) gaat nog de deur uit.
-- Ook cron-reminder-alarm en cron-reminder-alarm-digest lezen de kolommen.
--
-- CONTEXT
-- ─────────────────────────────────────────────────────────────────────────
-- Afspraak 20630959-… (gmail.col, 521 5.1.2 Domain does not exist) werd van
-- 21-09 tot 24-09 elke 3 min opnieuw gemaild (1.324 faillog-rijen) en elke
-- faillog-rij leidde tot een alarmmail (95 per dag). Oorzaak: de bevestiging
-- gaf de mail-claim bij élke fout vrij, zonder teller of onderscheid tussen
-- permanente en tijdelijke fouten.
--
-- SCHEMA (follow_up_appointments)
-- ─────────────────────────────────────────────────────────────────────────
-- lead_email_undeliverable_at      Eén marker per afspraak. Gezet bij een
-- lead_email_undeliverable_reason  permanente bounce (5.1.x, domain does not
--                                  exist, user unknown …) of bij een domein-
--                                  typefout bij import. Is 'ie gezet → de cron
--                                  slaat mail voor ALLE momenten over.
--                                  Het e-mailadres zelf wordt NOOIT gewijzigd.
-- bevestiging_mail_attempts        Mislukte mail-pogingen voor de bevestiging.
-- bevestiging_mail_next_at         Vroegste tijdstip voor de volgende poging.
-- bevestiging_wa_attempts          Idem voor WhatsApp.
-- bevestiging_wa_next_at
-- bevestiging_gaveup_at            Gezet zodra de bevestiging niet meer kan
-- bevestiging_gaveup_reason        slagen (cap van 7 bereikt of permanent).
--
-- Alle kolommen nullable of met default → bestaande rijen blijven geldig.

ALTER TABLE public.follow_up_appointments
  ADD COLUMN IF NOT EXISTS lead_email_undeliverable_at     timestamptz NULL,
  ADD COLUMN IF NOT EXISTS lead_email_undeliverable_reason text        NULL,
  ADD COLUMN IF NOT EXISTS bevestiging_mail_attempts       integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bevestiging_mail_next_at        timestamptz NULL,
  ADD COLUMN IF NOT EXISTS bevestiging_wa_attempts         integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bevestiging_wa_next_at          timestamptz NULL,
  ADD COLUMN IF NOT EXISTS bevestiging_gaveup_at           timestamptz NULL,
  ADD COLUMN IF NOT EXISTS bevestiging_gaveup_reason       text        NULL;

COMMENT ON COLUMN public.follow_up_appointments.lead_email_undeliverable_at IS
  'Gezet bij permanente bounce of domein-typefout. Cron slaat mail dan voor alle momenten over. Adres wordt nooit automatisch gewijzigd.';
COMMENT ON COLUMN public.follow_up_appointments.bevestiging_gaveup_at IS
  'Bevestiging opgegeven: cap (7 pogingen) bereikt of permanente fout. Cron pakt de rij niet meer op.';

NOTIFY pgrst, 'reload schema';

-- VERIFICATIE (verwacht 8 rijen):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'follow_up_appointments'
--      AND column_name IN ('lead_email_undeliverable_at','lead_email_undeliverable_reason',
--        'bevestiging_mail_attempts','bevestiging_mail_next_at','bevestiging_wa_attempts',
--        'bevestiging_wa_next_at','bevestiging_gaveup_at','bevestiging_gaveup_reason');
--
-- OPTIONEEL — de denzel-afspraak (al gestopt via bevestiging_sent_at) ook
-- formeel als onbezorgbaar markeren, zodat de 24u/2u/30m-reminders op 28/29-09
-- geen mail meer proberen:
--   UPDATE public.follow_up_appointments
--      SET lead_email_undeliverable_at = now(),
--          lead_email_undeliverable_reason = '521 5.1.2 Domain does not exist: gmail.col'
--    WHERE id = '20630959-f26b-4cfc-9bbf-2f0fc03d0c61'
--      AND lead_email_undeliverable_at IS NULL;
--
-- ADRES HANDMATIG GECORRIGEERD? Marker weghalen (anders blijft mail uit):
--   UPDATE public.follow_up_appointments
--      SET lead_email = '<juiste adres>',
--          lead_email_undeliverable_at = NULL, lead_email_undeliverable_reason = NULL
--    WHERE id = '<afspraak-id>';
-- (Wordt het adres in GHL gecorrigeerd, dan reset de GHL-poll de marker zelf.)
--
-- ROLLBACK:
--   ALTER TABLE public.follow_up_appointments
--     DROP COLUMN IF EXISTS lead_email_undeliverable_at,
--     DROP COLUMN IF EXISTS lead_email_undeliverable_reason,
--     DROP COLUMN IF EXISTS bevestiging_mail_attempts,
--     DROP COLUMN IF EXISTS bevestiging_mail_next_at,
--     DROP COLUMN IF EXISTS bevestiging_wa_attempts,
--     DROP COLUMN IF EXISTS bevestiging_wa_next_at,
--     DROP COLUMN IF EXISTS bevestiging_gaveup_at,
--     DROP COLUMN IF EXISTS bevestiging_gaveup_reason;
--   NOTIFY pgrst, 'reload schema';
--   (Eerst de code terugdraaien, anders faalt de reminder-cron.)
