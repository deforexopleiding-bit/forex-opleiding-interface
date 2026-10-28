-- PROJECT: forex-command-center (CRM)
--
-- 2026-10-28-onboarding-handmatig-status-backfill.sql — met de hand afgeronde
-- onboardings ook op status 'afgerond' zetten.
--
-- WAAROM
-- ------
-- "Met de hand afronden" (CRM-detail of het LMS-onboardingbord →
-- api/_lib/onboarding-handmatig.js) zette tot 28 okt alleen
-- handmatig_afgerond_op en liet status op aangemeld/bezig. Gemeten 28 okt:
-- 8 rijen (Rachael Njoki, Rahim Gusani, BV Ky, Eva Turcksin, Miguel Claeys,
-- Evertjan Graeff, Erduhan Ahmedov, Daniel Dimitrov). Alles wat op status leest
-- zag ze als lopend: de check-in-doelgroep sloot ze uit, "Moet onboarding nog
-- afronden" zou ze tonen, en de herinneringen "wizard nog niet gestart" lezen
-- status 'aangemeld'. Sinds de PR van 28 okt zet afronden ook status +
-- completed_at; dit zet de bestaande rijen recht.
--
-- WAT
-- ---
-- status 'aangemeld'/'bezig' + handmatig_afgerond_op of auto_afgerond_op →
--   status = 'afgerond', completed_at = dat tijdstip (HETZELFDE moment, zodat
--   wizardDoorKlantVoltooid() weet dat de klant de wizard niet zelf voltooide:
--   hij mag de nieuwe onboarding nog openen en invullen).
--
-- ⚠ VOLGORDE: draai dit pas NA de merge van de CRM-PR van 28 okt. Die sluit in
-- de catch-up van de onboarding-automations (trigger on_wizard_completed) de
-- met de hand / door een sessie afgesloten onboardings uit. Draai je dit
-- eerder, dan kan de cron-catch-up deze 8 klanten inschrijven in de
-- automations van wizard-afronding.
--
-- Herhaalbaar (tweede keer: 0 rijen). Rollback: onderaan.

-- ── CONTROLE VOORAF (alleen lezen) — verwacht de 8 rijen hierboven ───────────
select id, customer_name, status, completed_at, handmatig_afgerond_op, auto_afgerond_op
  from public.onboardings
 where status in ('aangemeld', 'bezig')
   and (handmatig_afgerond_op is not null or auto_afgerond_op is not null)
 order by customer_name;

-- ── DE BACKFILL — het resultaat IS de rollback-lijst (oude status en completed_at) ──
with oud as (
  select id, status, completed_at
    from public.onboardings
   where status in ('aangemeld', 'bezig')
     and (handmatig_afgerond_op is not null or auto_afgerond_op is not null)
     for update
)
update public.onboardings o
   set status       = 'afgerond',
       completed_at = coalesce(o.completed_at, o.handmatig_afgerond_op, o.auto_afgerond_op)
  from oud
 where o.id = oud.id
returning o.id, o.customer_name, oud.status as oude_status, oud.completed_at as oude_completed_at,
          o.status as nieuwe_status, o.completed_at as nieuwe_completed_at;

-- ── CONTROLE ACHTERAF (alleen lezen) — verwacht 0 ──────────────────────────
select count(*) as nog_scheef
  from public.onboardings
 where status in ('aangemeld', 'bezig')
   and (handmatig_afgerond_op is not null or auto_afgerond_op is not null);

-- ── ROLLBACK (NIET standaard draaien) ──────────────────────────────────────
-- De 8 gemeten rijen met hun status van vóór de backfill (28 okt 2026, alle
-- completed_at waren leeg). Alleen rijen die sindsdien niet meer veranderden
-- (completed_at = handmatig_afgerond_op) worden teruggezet.
--
-- update public.onboardings o
--    set status = v.oude_status, completed_at = null
--   from (values
--     ('091247af-a415-42d3-9133-6f5d26783229'::uuid, 'aangemeld'),  -- BV Ky
--     ('2c6361ee-c78b-425f-949c-7608cc77a3c7'::uuid, 'aangemeld'),  -- Daniel Dimitrov
--     ('477966f3-3334-424c-9e11-b25edd7b8a19'::uuid, 'bezig'),      -- Erduhan Ahmedov
--     ('bbbb0099-a2c4-497e-90f7-f65afe969b3a'::uuid, 'bezig'),      -- Eva Turcksin
--     ('49298ad7-b926-4796-9a39-aa2d13c6fa5e'::uuid, 'bezig'),      -- Evertjan Graeff
--     ('17ea7fcf-d235-4b4c-a579-770d0d81d9b4'::uuid, 'bezig'),      -- Miguel Claeys
--     ('99145132-0350-4b1b-813b-a69f0b7a7fbb'::uuid, 'bezig'),      -- Rachael Njoki
--     ('fda3a4ba-1779-4d4b-9695-47c05c398cc5'::uuid, 'aangemeld')   -- Rahim Gusani
--   ) as v(id, oude_status)
--  where o.id = v.id and o.status = 'afgerond' and o.completed_at = o.handmatig_afgerond_op;
