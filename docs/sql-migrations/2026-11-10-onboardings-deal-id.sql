-- 2026-11-10 — Welke offerte hoort bij een onboarding (offertewissel, Maxim).
--
-- NIET BLOKKEREND: de code leest en schrijft deal_id faalzacht. Zonder deze
-- kolom werkt "Deze offerte vervangt de lopende onboarding" gewoon; alleen de
-- koppeling met de offerte wordt dan niet bewaard (de uitkomst zegt het), en de
-- offertepagina leidt "hoort bij deze offerte" af uit het tekenmoment.
--
-- on delete set null: een offerte definitief verwijderen (TL + CRM) mag een
-- onboarding nooit meeslepen of blokkeren.

alter table public.onboardings
  add column if not exists deal_id uuid null references public.deals(id) on delete set null;

create index if not exists onboardings_deal_id_idx on public.onboardings (deal_id) where deal_id is not null;

comment on column public.onboardings.deal_id is
  'De getekende offerte waar deze onboarding bij hoort. Gezet bij aanmelden vanaf een offerte en bij een offertewissel (api/_lib/onboarding-offerte-wissel.js). NULL = onbekend (van vóór 10 nov 2026).';

-- Controle:
-- select count(*) filter (where deal_id is not null) as met_offerte, count(*) from public.onboardings;
