-- ─────────────────────────────────────────────────────────────────────────────
-- Taak 6, deel 1 — de belrij draagt meerdere redenen per persoon
-- ─────────────────────────────────────────────────────────────────────────────
-- ADDITIEF. Geen DROP, geen hernoemen, geen UPDATE op bestaande rijen, geen
-- aanpassing aan `iris_belrij` zelf. Eén nieuwe tabel, en verder niets.
--
-- WAAROM EEN APARTE TABEL EN GEEN `redenen jsonb` OP `iris_belrij`
-- Eén persoon kan om drie redenen tegelijk op de lijst staan: een bel-taak van
-- de wanbetalers, een mentorsignaal, en een verlopen opvolging. Die redenen
-- komen uit drie systemen, verdwijnen op drie momenten, en moeten ieder apart
-- afgevinkt kunnen worden. In een jsonb-kolom is "deze ene reden is weg" een
-- read-modify-write over de hele kolom; twee ronden die elkaar kruisen
-- overschrijven dan elkaars werk. Als rij is het een UPDATE op één regel.
-- Zelfde afweging als bij payment_arrangements / pending_actions (les 19).
--
-- WAAROM GEEN UNIEKE INDEX OP `iris_belrij (contact_id)`
-- Dat zou de echte garantie zijn voor "één rij per persoon", maar het breekt
-- een bestaand pad: de handmatige actie `belrij_toevoegen` in
-- `api/iris-actie.js` doet een gewone INSERT en zou vanaf dat moment op 23505
-- vallen voor iedereen die al op de lijst staat. Daarom eerst dat pad door
-- dezelfde samenvoeg-helper laten lopen (deel 2), en de index DAARNA. Tot die
-- tijd wordt "één rij per persoon" in de vuller afgedwongen, niet in het
-- schema. Dat staat hier zodat de volgende lezer niet denkt dat het vergeten is.
--
-- DRAAIEN: losse statements in de Supabase SQL-editor. Die knipt de invoer op
-- statement-grenzen en draait elk statement in zijn eigen transactie, dus
-- hieronder geen DO-blocks die state van elkaar verwachten.


-- ── CONTROLE VOOR ────────────────────────────────────────────────────────────
-- Verwacht: de tabel bestaat nog niet, en je ziet hoeveel personen er nu al
-- dubbel op de lijst staan. Staat dat getal boven 0, dan ruimt de vuller die
-- NIET op (hij raakt bestaande rijen niet aan) — dan is dat een losse opdracht.

select
  (select count(*) from public.iris_belrij)                                as belrij_rijen,
  (select count(distinct contact_id) from public.iris_belrij)              as personen,
  (select count(*) from (
     select contact_id from public.iris_belrij
     where status in ('open','bezig')
     group by contact_id having count(*) > 1
   ) d)                                                                    as personen_dubbel,
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'iris_belrij_redenen')  as tabel_bestaat_al;


-- ── 1. De tabel ──────────────────────────────────────────────────────────────

create table if not exists public.iris_belrij_redenen (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  belrij_id     uuid NOT NULL REFERENCES public.iris_belrij(id) ON DELETE CASCADE,
  bron          text NOT NULL
                  CHECK (bron IN ('wanbetaler','onboarding','mentorsignaal','geen_reactie','hand')),
  bron_sleutel  text NOT NULL,
  reden         text NOT NULL,
  reden_detail  text,
  bron_link     text,
  toegevoegd_op timestamptz NOT NULL DEFAULT now(),
  verwerkt_op   timestamptz
);

comment on table public.iris_belrij_redenen is
  'Iris: waarom iemand op de belrij staat. Meerdere regels per belrij-rij, want één persoon kan om meer dan één reden gebeld moeten worden.';
comment on column public.iris_belrij_redenen.bron is
  'Dezelfde verzameling als iris_belrij.bron, met opzet. Een verlopen opvolging valt onder geen_reactie — dat IS wat een verlopen opvolging betekent — zodat er geen CHECK-constraint verbouwd hoeft te worden.';
comment on column public.iris_belrij_redenen.bron_sleutel is
  'De sleutel van het bron-item, met een prefix per systeem: pending_action:<uuid>, signaal:<uuid>, opvolging:<uuid>. Hierop is de vuller idempotent.';
comment on column public.iris_belrij_redenen.bron_link is
  'Waar de beller naartoe moet om de bron te zien. Een pad binnen het CRM, nooit een volledig telefoonnummer en nooit een berichttekst.';
comment on column public.iris_belrij_redenen.verwerkt_op is
  'Gezet wanneer DEZE reden niet meer geldt. De belrij-rij blijft staan zolang er nog een onverwerkte reden onder hangt.';


-- ── 2. Indexen ───────────────────────────────────────────────────────────────
-- De unieke index is wat de vuller idempotent maakt: dezelfde bel-taak die in
-- twee ronden langskomt levert één regel op, niet twee.

create unique index if not exists idx_iris_belrij_redenen_bron
  on public.iris_belrij_redenen (belrij_id, bron_sleutel);

create index if not exists idx_iris_belrij_redenen_open
  on public.iris_belrij_redenen (belrij_id) where verwerkt_op is null;

create index if not exists idx_iris_belrij_redenen_sleutel
  on public.iris_belrij_redenen (bron_sleutel);


-- ── 3. RLS ───────────────────────────────────────────────────────────────────
-- Conform docs/rls-regels-nieuwe-tabellen.md en de rest van de iris_-tabellen:
-- dicht, met een rolcheck. Schrijven gaat via supabaseAdmin in de endpoints;
-- deze policy is de ondergrens voor wie rechtstreeks via PostgREST leest.

alter table public.iris_belrij_redenen enable row level security;

drop policy if exists iris_belrij_redenen_staff on public.iris_belrij_redenen;
create policy iris_belrij_redenen_staff on public.iris_belrij_redenen
  for all to authenticated
  using (public.is_crm_staff()) with check (public.is_crm_staff());


-- ── CONTROLE NA ──────────────────────────────────────────────────────────────
-- Verwacht: 8 kolommen, 3 indexen + de primary key, rls_aan = true, 0 rijen.

select
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='iris_belrij_redenen')  as kolommen,
  (select count(*) from pg_indexes
    where schemaname='public' and tablename='iris_belrij_redenen')     as indexen,
  (select relrowsecurity from pg_class
    where oid = 'public.iris_belrij_redenen'::regclass)                as rls_aan,
  (select count(*) from public.iris_belrij_redenen)                    as rijen;


-- ── TERUGDRAAIEN ─────────────────────────────────────────────────────────────
-- Alleen als de tabel nog leeg is. Staat er al iets in, dan is er al werk mee
-- gedaan en is weggooien geen rollback maar verlies.
--
--   drop table if exists public.iris_belrij_redenen;   -- NIET draaien zolang rijen > 0
