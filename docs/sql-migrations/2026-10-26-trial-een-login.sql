-- PROJECT: forex-command-center (nsjnsvlmdhunzqkdvagm)
--
-- 2026-10-26-trial-een-login.sql — "Eén login voor alle funnels"
--
-- Wat dit doet, in gewone taal
-- ----------------------------
-- Elke trial-lead (minicursus, 7-daagse, webinar, website, The Lab) krijgt nu
-- een lab-lead in het echte LMS. lab_aanmeldingen wordt daarmee DE lijst van
-- alle trials. Drie dingen:
--
--   1. lab_aanmeldingen krijgt de herkomst: product (de belofte), bron (de
--      funnel-slug) en variant (split-test-luik), plus toegang_aanvraag_id
--      (de WhatsApp-gate-rij waaruit de trial kwam — één trial per aanvraag).
--   2. app_settings 'trial_bestemming': de schakelaar per product
--      ('lab' = het echte LMS, 'oud' = het oude trial-LMS). Enkel als de rij
--      nog niet bestaat; een bestaande waarde blijft staan.
--   3. lms_gebruikers.lead_id: sinds ~5 okt leeg voor bijna alle nieuwe
--      trials (dfo-website gaf hem niet mee). Alleen LEGE waarden worden
--      gevuld, en alleen als er precies één niet-verwijderde lead met dat
--      e-mailadres is. Niets wordt overschreven.
--
-- Niet blokkerend: de code leest de kolommen fail-soft (zonder migratie
-- bewaart api/_lib/lab-trial.js de herkomst als 'trial:<product>:<bron>' in
-- landingspagina). Additief en herhaalbaar.
--
-- Rollback (1 en 2; 3 is een vulling van lege waarden):
--   alter table public.lab_aanmeldingen drop column if exists toegang_aanvraag_id,
--     drop column if exists variant, drop column if exists bron, drop column if exists product;
--   delete from public.app_settings where key = 'trial_bestemming';

-- ── Controle VÓÓR ─────────────────────────────────────────────────────────
-- Verwacht: kolommen 0, schakelaar 0, lege_lead_id ±225 (waarvan ±220 vulbaar).
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'lab_aanmeldingen'
      and column_name in ('product', 'bron', 'variant', 'toegang_aanvraag_id')) as kolommen,
  (select count(*) from public.app_settings where key = 'trial_bestemming') as schakelaar,
  (select count(*) from public.lms_gebruikers where lead_id is null) as lege_lead_id;

-- ── 1. Herkomst op lab_aanmeldingen ───────────────────────────────────────
alter table public.lab_aanmeldingen add column if not exists product text;
alter table public.lab_aanmeldingen add column if not exists bron text;
alter table public.lab_aanmeldingen add column if not exists variant text;
alter table public.lab_aanmeldingen add column if not exists toegang_aanvraag_id uuid;

comment on column public.lab_aanmeldingen.product is
  'De belofte (minicursus/7-daagse/webinar/website/the-lab/…). NULL = vóór 26 okt 2026 = the-lab.';
comment on column public.lab_aanmeldingen.toegang_aanvraag_id is
  'toegang_aanvragen.id waaruit deze trial kwam (WhatsApp-gate). Eén trial per aanvraag.';

create index if not exists lab_aanmeldingen_product_idx on public.lab_aanmeldingen (product, aangemaakt desc);
create unique index if not exists lab_aanmeldingen_toegang_aanvraag_uniek
  on public.lab_aanmeldingen (toegang_aanvraag_id) where toegang_aanvraag_id is not null;

-- ── 2. De schakelaar ──────────────────────────────────────────────────────
insert into public.app_settings (key, value)
values ('trial_bestemming',
        '{"minicursus":"lab","7-daagse":"lab","webinar":"lab","website":"lab","the-lab":"lab"}'::jsonb)
on conflict (key) do nothing;

-- ── 3. lead_id op het oude trial-LMS (alleen lege waarden) ────────────────
update public.lms_gebruikers g
   set lead_id = l.id
  from (
    select lower(email) as em, (array_agg(id))[1] as id
      from public.leads
     where verwijderd_op is null and email is not null
     group by lower(email)
    having count(*) = 1
  ) l
 where g.lead_id is null
   and lower(g.email) = l.em;

-- ── Controle NA ───────────────────────────────────────────────────────────
-- Verwacht: kolommen 4, schakelaar 1, lege_lead_id ±5 (geen of dubbele lead).
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'lab_aanmeldingen'
      and column_name in ('product', 'bron', 'variant', 'toegang_aanvraag_id')) as kolommen,
  (select count(*) from public.app_settings where key = 'trial_bestemming') as schakelaar,
  (select count(*) from public.lms_gebruikers where lead_id is null) as lege_lead_id;
