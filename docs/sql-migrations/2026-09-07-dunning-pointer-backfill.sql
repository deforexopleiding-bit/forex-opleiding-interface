-- 2026-09-07 · Pointer-backfill aanmaan-ladder — SQL-variant
--
-- Zelfde backfill als `scripts/dunning-pointer-backfill.js`, maar uitvoerbaar
-- vanuit de Supabase SQL-editor. Bedoeld voor wie geen terminal en geen
-- SUPABASE_SERVICE_ROLE_KEY heeft: het node-script en dit bestand komen op
-- exact dezelfde verzettingen uit (aangetoond tegen
-- scripts/fixtures/dunning-backfill-voorbeeld.json — zie de PR-beschrijving).
--
-- ══════════════════════════════════════════════════════════════════════════
--  TWEE BLOKKEN. LEES DIT VOOR JE IETS DRAAIT.
--
--  BLOK 1 is een SELECT. Die WIJZIGT NIETS. Draai 'm, lees de uitvoer, en
--  vergelijk met de dry-run in de PR-beschrijving.
--
--  BLOK 2 verzet de pointers en schrijft dunning_log-regels. Draai dat pas
--  NADAT de uitvoer van blok 1 gecontroleerd is. Er gaat ook dan GEEN bericht
--  uit: dit bestand raakt geen enkele send-code aan.
--
--  Draai elk blok APART. De Supabase SQL-editor knipt input op
--  statement-grenzen en draait elk statement in een eigen transactie; beide
--  blokken zijn daarom precies één statement, zonder temp-tabellen en zonder
--  DO-blocks die state van elkaar verwachten (zie Lessons Learned in
--  CLAUDE.md). Er staat bewust ook geen ON CONFLICT in: `app_settings` en
--  vrienden kunnen partial unique indexes hebben, en die kunnen geen
--  ON CONFLICT-arbiter zijn.
-- ══════════════════════════════════════════════════════════════════════════
--
-- WAT DE BACKFILL DOET
-- De ladder hangt sinds PR #1466 aan `days_overdue`, maar de pointer van
-- bestaande runs staat nog waar de oude, op de stap-pointer gebaseerde flow
-- was gebleven. Een klant die 45 dagen te laat is terwijl zijn pointer op de
-- eerste stap staat, heeft alle sporten al gepasseerd — zonder backfill loopt
-- die de hele reeks alsnog af, en het eerste bericht is "misschien had je het
-- gemist" na anderhalve maand.
--
-- GEPAUZEERDE RUNS DOEN MEE. Dat is de kern, geen detail: gepauzeerde runs
-- sturen nu niets maar cascaderen alsnog zodra hun pauze wegvalt. Hun status
-- blijft ongemoeid — alleen de pointer verschuift.
--
-- TOON-BESLISSING (Maxim): runs die gepauzeerd zijn door een LOPEND GESPREK
-- (`paused_by_conversation_id` gezet) landen op ÉÉN SPORT LAGER dan de hoogste
-- bereikte sport. Deze runs staan stil omdat er een lopend gesprek met de
-- klant in de inbox is; meteen het slotbericht sturen terwijl er nog een
-- uitwisseling loopt past niet. Is er maar één sport bereikt, dan blijft die
-- staan — nooit lager dan de laagste bereikte sport.
--
-- IDEMPOTENT. Staat de pointer al goed of verder, dan gebeurt er niets. Blok 1
-- na blok 2 hoort nul regels met besluit = 'VERZETTEN' te geven.


-- ══════════════════════════════════════════════════════════════════════════
-- BLOK 1 — ALLEEN LEZEN. Wijzigt niets.
-- ══════════════════════════════════════════════════════════════════════════

with peildatum as (
  -- Europe/Amsterdam, niet UTC: rond middernacht scheelt dat een hele dag.
  select (now() at time zone 'Europe/Amsterdam')::date as today
),
ladder as (
  -- app_settings.dunning_ladder over de defaults heen, zelfde regels als
  -- parseLadder(): platte vorm of { "rungs": {...} }, alleen gehele waarden
  -- 0..365 tellen mee, de rest valt terug op de default.
  select '{"aanmaning_dag7":1,"aanmaning_dag14":7,"aanmaning_dag17":14,'
         '"aanmaning_dag21":21,"aanmaning_dag37":30}'::jsonb
         || coalesce((
              select jsonb_object_agg(e.k, trunc(e.v::numeric)::int)
                from app_settings s
                cross join lateral (
                  select k, v from jsonb_each_text(
                    case when s.value ? 'rungs' then s.value->'rungs' else s.value end
                  ) as t(k, v)
                ) e
               where s.key = 'dunning_ladder'
                 and e.v ~ '^-?[0-9]+(\.[0-9]+)?$'
                 and trunc(e.v::numeric) between 0 and 365
            ), '{}'::jsonb) as j
),
stap as (
  -- Ladder-sport per stap: expliciete config wint, anders de ladder op
  -- meta_template_name en daarna op name. De naam van de stap wordt NIET
  -- geparsed — "aanmaning_dag7" is een sleutel, geen dagnummer.
  select s.id, s.workflow_id, s.step_order, lower(s.step_type) as step_type,
         case
           -- JSON-null gedraagt zich in de JS-variant als 0 (Number(null)===0);
           -- hier expliciet nagebootst zodat beide hetzelfde plan geven.
           when jsonb_typeof(s.config->'min_days_overdue') = 'null' then 0
           when (s.config->>'min_days_overdue') ~ '^-?[0-9]+(\.[0-9]+)?$'
                and trunc((s.config->>'min_days_overdue')::numeric) >= 0
             then trunc((s.config->>'min_days_overdue')::numeric)::int
           when l.j ? t.meta_template_name then trunc((l.j->>t.meta_template_name)::numeric)::int
           when l.j ? t.name               then trunc((l.j->>t.name)::numeric)::int
           else null
         end as tier,
         coalesce(t.meta_template_name, t.name) as template_naam
    from dunning_workflow_steps s
    cross join ladder l
    left join dunning_templates t on t.id::text = s.config->>'template_id'
),
klant as (
  -- Oudste vervaldatum over de facturen die écht nog openstaan. Een factuur
  -- met status 'open' maar volledig betaald/gecrediteerd telt niet mee.
  select i.customer_id,
         min(i.due_date)::date as oldest_due,
         coalesce(nullif(btrim(
           case when c.is_company then coalesce(c.company_name, '')
                else concat_ws(' ', nullif(btrim(coalesce(c.first_name, '')), ''),
                                    nullif(btrim(coalesce(c.last_name,  '')), ''))
           end), ''), '(zonder naam)') as naam
    from invoices i
    join customers c on c.id = i.customer_id
   where i.status in ('open', 'partially_paid', 'overdue')
     and i.is_test is not true
     and i.due_date is not null
     and (coalesce(i.amount_total, 0) - coalesce(i.amount_paid, 0) - coalesce(i.credited_amount, 0)) > 0
   group by i.customer_id, c.is_company, c.company_name, c.first_name, c.last_name
),
run as (
  select r.id, r.workflow_id, r.customer_id, r.status, r.current_step_id,
         r.needs_attention, r.paused_by_conversation_id, r.paused_by_arrangement_id,
         r.paused_manual_reason,
         k.oldest_due,
         coalesce(k.naam, r.customer_id::text) as naam,
         (p.today - k.oldest_due) as dagen_te_laat,
         (r.status = 'paused' and r.paused_by_conversation_id is not null) as gesprekspauze,
         cur.step_order as van_step_order,
         (select count(*) from dunning_workflow_steps s2 where s2.workflow_id = r.workflow_id) as aantal_stappen
    from dunning_workflow_runs r
    cross join peildatum p
    left join klant k on k.customer_id = r.customer_id
    left join dunning_workflow_steps cur on cur.id = r.current_step_id
   where r.status in ('active', 'paused')
),
bereikt as (
  -- Alle send-stappen waarvan de sport al gepasseerd is, op volgorde van
  -- step_order. Alleen stappen MÉT een sport tellen: de e-mails ("Aanmaning
  -- dag N (E-mail)") staan niet op de ladder en zijn dus geen sport op zich.
  select r.id as run_id, s.id as step_id, s.step_order, s.tier, s.template_naam,
         row_number() over (partition by r.id order by s.step_order desc) as van_achter,
         count(*)     over (partition by r.id)                            as aantal
    from run r
    join stap s on s.workflow_id = r.workflow_id
   where s.step_type in ('email', 'whatsapp')
     and s.tier is not null
     and r.dagen_te_laat is not null
     and r.dagen_te_laat >= s.tier
),
doel as (
  select r.id as run_id,
         h.step_id       as hoogste_step_id,
         h.step_order    as hoogste_step_order,
         h.tier          as hoogste_sport,
         h.template_naam as hoogste_template,
         h.aantal        as bereikte_sporten,
         g.step_id       as doel_step_id,
         g.step_order    as doel_step_order,
         g.tier          as doel_sport,
         g.template_naam as doel_template,
         (g.step_id is distinct from h.step_id) as toon_verlaagd
    from run r
    join bereikt h on h.run_id = r.id and h.van_achter = 1
    join bereikt g on g.run_id = r.id
                  and g.van_achter = case when r.gesprekspauze and h.aantal >= 2 then 2 else 1 end
)
select
  case
    when r.oldest_due is null                                          then 'OVERSLAAN'
    when r.aantal_stappen = 0                                          then 'OVERSLAAN'
    when r.needs_attention                                             then 'OVERSLAAN'
    when r.dagen_te_laat < 1                                           then 'OVERSLAAN'
    when d.run_id is null                                              then 'OVERSLAAN'
    when r.van_step_order is not null
         and r.van_step_order >= d.doel_step_order                     then 'OVERSLAAN'
    else 'VERZETTEN'
  end                                                    as besluit,
  r.naam                                                 as klant,
  r.status                                               as run_status,
  case when r.status = 'paused' then
    case when r.paused_by_conversation_id is not null then 'gesprek'
         when r.paused_by_arrangement_id  is not null then 'arrangement'
         else coalesce(r.paused_manual_reason, 'overig') end
  end                                                    as pauze_reden,
  r.dagen_te_laat,
  r.oldest_due                                           as oudste_vervaldatum,
  r.van_step_order                                       as van_stap,
  d.doel_step_order                                      as naar_stap,
  d.doel_template                                        as doel_sport_template,
  d.doel_sport                                           as doel_sport_dag,
  d.hoogste_template                                     as hoogste_bereikte_template,
  d.bereikte_sporten,
  coalesce(d.toon_verlaagd, false)                       as toon_verlaagd,
  case
    when r.oldest_due is null      then 'geen openstaande factuur met vervaldatum'
    when r.aantal_stappen = 0      then 'workflow zonder stappen'
    when r.needs_attention         then 'needs_attention — mens moet er eerst naar kijken'
    when r.dagen_te_laat < 1       then format('nog niet vervallen (%s dagen)', r.dagen_te_laat)
    when d.run_id is null          then 'geen ladder-sport bereikt'
    when r.van_step_order is not null and r.van_step_order >= d.doel_step_order then
      case when d.toon_verlaagd
           then 'na de toon-verlaging staat de pointer al goed (gesprekspauze)'
           else 'pointer staat al goed of verder' end
  end                                                    as reden,
  r.id                                                   as run_id,
  r.current_step_id                                      as van_step_id,
  d.doel_step_id                                         as naar_step_id
from run r
left join doel d on d.run_id = r.id
order by besluit, r.dagen_te_laat desc nulls last, klant;


-- ══════════════════════════════════════════════════════════════════════════
-- BLOK 2 — SCHRIJFT. Pas draaien nadat blok 1 gecontroleerd is.
--
-- Verzet uitsluitend `dunning_workflow_runs.current_step_id` (+ updated_at)
-- en voegt een `dunning_log`-regel toe per verzetting. Verstuurt niets.
--
-- OVER DE RACE — lees dit, want het werkt nét anders dan het node-script.
-- Het node-script leest in de ene HTTP-call en schrijft in de volgende; daar
-- zit een gat tussen, en daarom bewaart het per run de pointer die het zag en
-- schrijft het alleen als die er nog staat. Dit blok heeft dat gat niet: het
-- berekent het plan opnieuw en schrijft in ÉÉN statement, dus in één
-- transactie op één snapshot. Wat het node-script met een guard afdwingt, is
-- hier structureel.
--
-- Wat dat garandeert:
--   * een run die tussen blok 1 en blok 2 door een cron-tick al voorbij de
--     doelstap is geschoven, wordt overgeslagen (dezelfde idempotentieregel:
--     alleen verzetten als de pointer nog vóór de doelstap staat);
--   * een pointer gaat nooit achteruit, en nooit twee keer.
--
-- Wat het NIET garandeert: dat de verzameling byte-voor-byte gelijk is aan wat
-- blok 1 je liet zien. Wordt er in de tussentijd een factuur opeens vervallen,
-- of haalt iemand `needs_attention` weg, dan kan blok 2 een run meenemen die
-- blok 1 nog niet toonde. Vandaar de RETURNING onderaan: de uitvoer is één
-- regel per daadwerkelijk verzette run, dus je ziet achteraf precies wat er
-- gebeurd is. Wijkt het aantal af van blok 1, kijk dan naar de verschilregels
-- vóór je verder gaat.
--
-- De expliciete `van_step_id`-vergelijking hieronder staat er als tweede slot
-- en om de bedoeling leesbaar te houden; hij spiegelt de guard uit het
-- node-script.
-- ══════════════════════════════════════════════════════════════════════════

with peildatum as (
  select (now() at time zone 'Europe/Amsterdam')::date as today
),
ladder as (
  select '{"aanmaning_dag7":1,"aanmaning_dag14":7,"aanmaning_dag17":14,'
         '"aanmaning_dag21":21,"aanmaning_dag37":30}'::jsonb
         || coalesce((
              select jsonb_object_agg(e.k, trunc(e.v::numeric)::int)
                from app_settings s
                cross join lateral (
                  select k, v from jsonb_each_text(
                    case when s.value ? 'rungs' then s.value->'rungs' else s.value end
                  ) as t(k, v)
                ) e
               where s.key = 'dunning_ladder'
                 and e.v ~ '^-?[0-9]+(\.[0-9]+)?$'
                 and trunc(e.v::numeric) between 0 and 365
            ), '{}'::jsonb) as j
),
stap as (
  select s.id, s.workflow_id, s.step_order, lower(s.step_type) as step_type,
         case
           when jsonb_typeof(s.config->'min_days_overdue') = 'null' then 0
           when (s.config->>'min_days_overdue') ~ '^-?[0-9]+(\.[0-9]+)?$'
                and trunc((s.config->>'min_days_overdue')::numeric) >= 0
             then trunc((s.config->>'min_days_overdue')::numeric)::int
           when l.j ? t.meta_template_name then trunc((l.j->>t.meta_template_name)::numeric)::int
           when l.j ? t.name               then trunc((l.j->>t.name)::numeric)::int
           else null
         end as tier,
         coalesce(t.meta_template_name, t.name) as template_naam
    from dunning_workflow_steps s
    cross join ladder l
    left join dunning_templates t on t.id::text = s.config->>'template_id'
),
klant as (
  select i.customer_id,
         min(i.due_date)::date as oldest_due,
         coalesce(nullif(btrim(
           case when c.is_company then coalesce(c.company_name, '')
                else concat_ws(' ', nullif(btrim(coalesce(c.first_name, '')), ''),
                                    nullif(btrim(coalesce(c.last_name,  '')), ''))
           end), ''), '(zonder naam)') as naam
    from invoices i
    join customers c on c.id = i.customer_id
   where i.status in ('open', 'partially_paid', 'overdue')
     and i.is_test is not true
     and i.due_date is not null
     and (coalesce(i.amount_total, 0) - coalesce(i.amount_paid, 0) - coalesce(i.credited_amount, 0)) > 0
   group by i.customer_id, c.is_company, c.company_name, c.first_name, c.last_name
),
run as (
  select r.id, r.workflow_id, r.customer_id, r.status, r.current_step_id,
         r.needs_attention, r.paused_by_conversation_id, r.paused_by_arrangement_id,
         r.paused_manual_reason,
         k.oldest_due,
         coalesce(k.naam, r.customer_id::text) as naam,
         (p.today - k.oldest_due) as dagen_te_laat,
         (r.status = 'paused' and r.paused_by_conversation_id is not null) as gesprekspauze,
         cur.step_order as van_step_order,
         p.today as peildag,
         (select count(*) from dunning_workflow_steps s2 where s2.workflow_id = r.workflow_id) as aantal_stappen
    from dunning_workflow_runs r
    cross join peildatum p
    left join klant k on k.customer_id = r.customer_id
    left join dunning_workflow_steps cur on cur.id = r.current_step_id
   where r.status in ('active', 'paused')
),
bereikt as (
  select r.id as run_id, s.id as step_id, s.step_order, s.tier, s.template_naam,
         row_number() over (partition by r.id order by s.step_order desc) as van_achter,
         count(*)     over (partition by r.id)                            as aantal
    from run r
    join stap s on s.workflow_id = r.workflow_id
   where s.step_type in ('email', 'whatsapp')
     and s.tier is not null
     and r.dagen_te_laat is not null
     and r.dagen_te_laat >= s.tier
),
doel as (
  select r.id as run_id,
         h.step_id as hoogste_step_id, h.step_order as hoogste_step_order,
         h.tier as hoogste_sport, h.template_naam as hoogste_template,
         h.aantal as bereikte_sporten,
         g.step_id as doel_step_id, g.step_order as doel_step_order,
         g.tier as doel_sport, g.template_naam as doel_template,
         (g.step_id is distinct from h.step_id) as toon_verlaagd
    from run r
    join bereikt h on h.run_id = r.id and h.van_achter = 1
    join bereikt g on g.run_id = r.id
                  and g.van_achter = case when r.gesprekspauze and h.aantal >= 2 then 2 else 1 end
),
plan as (
  select r.id as run_id, r.status as run_status, r.customer_id, r.naam,
         r.dagen_te_laat, r.oldest_due, r.current_step_id as van_step_id,
         r.van_step_order, r.gesprekspauze, r.peildag,
         case when r.status = 'paused' then
           case when r.paused_by_conversation_id is not null then 'gesprek'
                when r.paused_by_arrangement_id  is not null then 'arrangement'
                else coalesce(r.paused_manual_reason, 'overig') end
         end as pauze_reden,
         d.doel_step_id, d.doel_step_order, d.doel_sport, d.doel_template,
         d.hoogste_step_order, d.hoogste_template, d.toon_verlaagd
    from run r
    join doel d on d.run_id = r.id
   where r.oldest_due is not null
     and r.aantal_stappen > 0
     and r.needs_attention is not true
     and r.dagen_te_laat >= 1
     and (r.van_step_order is null or r.van_step_order < d.doel_step_order)
),
verzet as (
  update dunning_workflow_runs r
     set current_step_id = p.doel_step_id,
         updated_at      = now()
    from plan p
   where r.id = p.run_id
     -- Race-guard: alleen als de pointer nog staat waar blok 1 hem zag.
     and (p.van_step_id is null or r.current_step_id = p.van_step_id)
  returning r.id as run_id, r.current_step_id
)
insert into dunning_log (run_id, step_id, event_type, payload)
select v.run_id, p.doel_step_id, 'pointer_backfill',
       jsonb_build_object(
         'reason', 'eenmalige ladder-backfill: pointer op de sport die bij days_overdue hoort',
         'bron', 'sql-blok-2',
         'run_status', p.run_status,
         'customer_id', p.customer_id,
         'days_overdue', p.dagen_te_laat,
         'oldest_due_date', p.oldest_due,
         'from_step_id', p.van_step_id,
         'from_step_order', p.van_step_order,
         'to_step_id', p.doel_step_id,
         'to_step_order', p.doel_step_order,
         'to_template', p.doel_template,
         'ladder_rung', p.doel_sport,
         'conversation_paused', p.gesprekspauze,
         'tone_downgrade', p.toon_verlaagd,
         'downgrade_reason', case when p.toon_verlaagd
           then 'gepauzeerd door lopend gesprek — niet met de deur in huis' end,
         'highest_reached_step_order', p.hoogste_step_order,
         'highest_reached_template', p.hoogste_template,
         'today_amsterdam', p.peildag,
         'sent_anything', false
       )
  from verzet v
  join plan p on p.run_id = v.run_id
returning run_id, step_id, payload->>'to_template' as doel_sport_template;
