-- ═══════════════════════════════════════════════════════════════════════════
-- Opvolging · fase 1 — nieuwe tabellen voor het dagsysteem van Dave
-- 3 september 2026
--
-- Puur additief. Er wordt geen bestaande tabel, kolom, policy of functie
-- aangeraakt. De oude Follow-up-module blijft ongewijzigd draaien op
-- follow_up_leads / follow_up_lead_notes.
--
-- RLS volgens docs/rls-regels-nieuwe-tabellen.md: RLS aan + een policy met
-- een echte rolcheck via public.is_crm_staff(). Geen USING (true), geen
-- "heeft een profiel"-check.
--
-- Gemeten vóór het schrijven (3 sep 2026): opvolging_taken en
-- opvolging_pogingen bestonden nog niet; is_crm_staff() is de rolcheck die
-- de repo voorschrijft voor CRM-data.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1 · De takenpot ────────────────────────────────────────────────────────
create table if not exists public.opvolging_taken (
  id                        uuid primary key default gen_random_uuid(),
  naam                      text not null,
  email                     text,
  telefoon                  text,                 -- E.164, koppelt call-logs en WhatsApp
  reden                     text not null,
  reden_code                text,                 -- reden uit Event afronden, of het bezwaar
  bron                      text not null default 'handmatig',
  bron_ref                  jsonb not null default '{}'::jsonb,   -- event_id, attendee_id, appointment_id
  badge_label               text,                 -- bv. 'Masterclass Gent · 27 aug'
  notitie                   text,
  due                       date not null default current_date,
  later                     boolean not null default false,       -- tweede ronde van vandaag
  status                    text not null default 'open',
  uitgesteld_zonder_poging  integer not null default 0,
  eigenaar_id               uuid,
  agenda_doorgestuurd_at    timestamptz,          -- startpunt van de 48-uurklok
  afspraak_gevonden_at      timestamptz,
  afspraak_ref              jsonb,
  gearchiveerd_at           timestamptz,
  archief_reden             text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint opvolging_taken_status_chk check (status in ('open','wacht_inplanning','ingepland','gearchiveerd')),
  constraint opvolging_taken_reden_chk  check (reden  in ('wil_nog_beslissen','no_show_event','no_show_call','afgemeld','niet_ingepland')),
  constraint opvolging_taken_bron_chk   check (bron   in ('event','call','handmatig'))
);

create index if not exists opvolging_taken_due_idx      on public.opvolging_taken (due) where status = 'open';
create index if not exists opvolging_taken_eigenaar_idx on public.opvolging_taken (eigenaar_id);
create index if not exists opvolging_taken_status_idx   on public.opvolging_taken (status);
create index if not exists opvolging_taken_wacht_idx    on public.opvolging_taken (agenda_doorgestuurd_at) where status = 'wacht_inplanning';
create index if not exists opvolging_taken_tel_idx      on public.opvolging_taken (telefoon);

-- ── 2 · Het bewijsmateriaal ────────────────────────────────────────────────
-- Eén rij per gebeurtenis, nooit overschrijven. Hierop worden "op tijd of te
-- laat", het aantal belpogingen en het aantal verschillende dagen berekend.
create table if not exists public.opvolging_pogingen (
  id           uuid primary key default gen_random_uuid(),
  taak_id      uuid not null references public.opvolging_taken(id) on delete cascade,
  soort        text not null,
  tijdstip     timestamptz not null default now(),
  resultaat    text,
  automatisch  boolean not null default false,    -- true = uit softphone/WhatsApp-brug
  call_log_id  text,
  duur_sec     integer,
  created_at   timestamptz not null default now(),
  constraint opvolging_pogingen_soort_chk check (soort in ('call','whatsapp','spraakbericht','agenda_doorgestuurd','ingepland'))
);

create index if not exists opvolging_pogingen_taak_idx on public.opvolging_pogingen (taak_id, tijdstip desc);
create index if not exists opvolging_pogingen_dag_idx  on public.opvolging_pogingen (tijdstip);

-- ── 3 · RLS volgens het huisrecept ─────────────────────────────────────────
alter table public.opvolging_taken    enable row level security;
alter table public.opvolging_pogingen enable row level security;

drop policy if exists opvolging_taken_staff on public.opvolging_taken;
create policy opvolging_taken_staff
  on public.opvolging_taken
  for all
  to authenticated
  using (public.is_crm_staff())
  with check (public.is_crm_staff());

drop policy if exists opvolging_pogingen_staff on public.opvolging_pogingen;
create policy opvolging_pogingen_staff
  on public.opvolging_pogingen
  for all
  to authenticated
  using (public.is_crm_staff())
  with check (public.is_crm_staff());
