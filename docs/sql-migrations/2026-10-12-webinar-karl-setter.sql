-- 2026-10-12-webinar-karl-setter.sql
--
-- STATUS: handmatig draaien in de Supabase SQL-editor (Jeffrey). Muterend.
--
-- Webinar fase 2 — Karl Eireiner (host) krijgt 3% commissie over sales uit
-- boekingen via de webinar-QR (https://deforexopleiding.nl/agenda/webinar),
-- via de BESTAANDE setter-opzet (zelfde motor als Romy). Geen nieuwe logica:
--
--   booking_sources (slug 'webinar', label 'webinar qr') heeft
--   owner_user_id = Karl  →  boeking: follow_up_appointments.setter_user_id = Karl
--   (api/_lib/create-appointment-from-lead.js)  →  deal: deals.setter_user_id
--   (api/sales-deal-create.js, oudste boeking met setter)  →  commissie-cron
--   (api/cron-setter-cash-release.js): pct uit setter_config × wat de klant
--   echt betaalde.
--
-- Deze migratie voegt alleen Karls setter_config-rij toe.
--   - pct 3.00, monthly_fee 0 (geen vaste vergoeding → het maandrapport geeft
--     alleen commissieregels; zonder commissie wordt er voor Karl geen rapport
--     aangemaakt: skipEmpty in api/cron/generate-setter-reports.js).
--   - effective_from = vandaag: alleen facturen die vanaf vandaag betaald worden.
--   - De dry-run (app_settings.setter_commissie_dry_run) blijft AAN; deze
--     migratie raakt die NIET aan. Zolang die aan staat rekent de cron wel,
--     maar boekt niets — ook niet voor Karl.
--
-- Karl Eireiner = profiles.id / auth.users.id fdc50852-2f29-46d6-b9bd-9bcfd4ed8ee7
-- (read-only opgezocht 2026-10-12; profiles.full_name 'Karl Eireiner', rol mentor).
-- Zijn rol blijft 'mentor' — de setter-scope geldt alleen voor de rol
-- appointmentsetter, dus zijn eigen schermen veranderen niet.
--
-- Eén statement, herhaalbaar (bestaat de rij al → niets).

INSERT INTO public.setter_config (user_id, pct, is_active, effective_from, monthly_fee)
VALUES ('fdc50852-2f29-46d6-b9bd-9bcfd4ed8ee7', 3.00, true, CURRENT_DATE, 0)
ON CONFLICT (user_id) DO NOTHING;

-- Controle (lezend):
-- SELECT c.user_id, p.full_name, c.pct, c.is_active, c.effective_from, c.monthly_fee
-- FROM public.setter_config c JOIN public.profiles p ON p.id = c.user_id;
-- SELECT slug, label, actief, owner_user_id FROM public.booking_sources WHERE slug = 'webinar';
--   → owner_user_id moet fdc50852-2f29-46d6-b9bd-9bcfd4ed8ee7 (Karl) zijn.
