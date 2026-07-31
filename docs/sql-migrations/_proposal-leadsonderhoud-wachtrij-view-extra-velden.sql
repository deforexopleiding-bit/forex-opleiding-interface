-- ============================================================================
-- VOORSTEL (niet auto-draaien) — Wachtrij-view uitbreiden met template-variabelen
-- Datum: 2026-07-31
--
-- Reden: fix A uit de "WhatsApp-templates werken niet"-check. Templates
-- 'halverwege_warm' en 'gesprek_herinnering' hebben variabelen die de motor
-- nu niet aanreikt:
--   * halverwege_warm  → {{2}} = lessen_gezien, {{3}} = trades
--   * gesprek_herinnering → {{2}} = tijd (van de aanstaande afspraak)
--
-- Meta weigert een send bij een lege parameter. De defensieve guard in
-- cron-leadsonderhoud.js (PR #10XX) skipt de send + logt welke variabele
-- ontbreekt — maar de KLANT ontvangt dan nog steeds geen bericht. Om echt
-- te versturen moet de wachtrij-view die kolommen leveren.
--
-- ⚠ ONTBREKEND: exacte bron-tabellen voor deze velden. Jeffrey moet invullen:
--   * lessen_gezien — welke tabel/kolom? (Bubble sync? activity_log?
--     progress_events? lesson_views? Ik heb geen migration in repo gevonden
--     voor deze data. Als 't in Bubble leeft: eerst syncen naar Supabase.)
--   * trades         — waarschijnlijk sa_trades count(*) per owner_id.
--   * gesprek_tijd   — follow_up_appointments.scheduled_at, formatted HH:MM,
--     voor de eerstvolgende scheduled_at per lead.
--
-- Vervang de <PLACEHOLDER>-blokken en draai de CREATE OR REPLACE VIEW.
-- Motor-code leest deze kolommen automatisch via bouwVariabelen() zodra ze
-- op de row staan (r.lessen_gezien, r.trades, r.gesprek_tijd) — geen extra
-- code-wijziging nodig.
-- ============================================================================

-- Stap 1: bekijk de huidige view-definitie zodat je 'em niet per ongeluk breekt.
-- Voer eerst uit:
--   SELECT pg_get_viewdef('public.onderhoud_wachtrij'::regclass, true);
-- en gebruik dat als startpunt.

-- Stap 2: voeg de 3 kolommen toe. Voorbeeld-template (aan te vullen):
/*
CREATE OR REPLACE VIEW public.onderhoud_wachtrij AS
SELECT
  w.*,  -- bestaande kolommen
  -- lessen_gezien: <VUL BRON IN>
  --   Voorbeeld als er een Bubble-sync-tabel is:
  --   (SELECT count(*) FROM public.lesson_views lv WHERE lv.gebruiker_id = w.gebruiker_id) AS lessen_gezien,
  0::int AS lessen_gezien,   -- <PLACEHOLDER — vervang door echte lookup>

  -- trades: count van sa_trades per gebruiker.
  (SELECT count(*) FROM public.sa_trades t WHERE t.owner_id = w.gebruiker_id) AS trades,

  -- gesprek_tijd: eerstvolgende scheduled_at van follow_up_appointments,
  -- geformatteerd als HH:MM in Europe/Amsterdam.
  (
    SELECT to_char(
      fa.scheduled_at AT TIME ZONE 'Europe/Amsterdam',
      'HH24:MI'
    )
    FROM public.follow_up_appointments fa
    WHERE fa.lead_ghl_contact_id = w.ghl_contact_id  -- <CHECK: kolomnaam in view>
      AND fa.scheduled_at > now()
      AND fa.status NOT IN ('cancelled','no_show')
    ORDER BY fa.scheduled_at ASC
    LIMIT 1
  ) AS gesprek_tijd
FROM public.<HUIDIGE_VIEW_BASE> w;  -- <VUL IN — base-tabellen uit pg_get_viewdef>
*/

-- Stap 3: verifieer met een steekproef:
--   SELECT gebruiker_id, soort, lessen_gezien, trades, gesprek_tijd
--   FROM onderhoud_wachtrij
--   WHERE soort IN ('halverwege_warm','gesprek_herinnering') LIMIT 5;

-- ROLLBACK: revert naar de pre-migration view-definitie uit stap 1.
