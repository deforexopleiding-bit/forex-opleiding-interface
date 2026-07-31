-- ============================================================================
-- Publicatielaag voor de aanmeld-vragenlijst (dfo-website + CRM-editor).
-- Werk-versie: website_quizzes + website_quiz_questions (CRM bewerkt die).
-- Live: website_quiz_publicaties (snapshots) — de website leest ALLEEN dit.
--
-- RLS: aan. De website leest via de anon-rol (alleen SELECT). Schrijven
-- (publiceren/rollback) gebeurt uitsluitend via de service role vanuit de CRM;
-- die bypasst RLS. Consistent met website_quizzes/_questions (al RLS-aan +
-- anon-alleen-lezen).
--
-- NB: draai na deze DDL "NOTIFY pgrst, 'reload schema';" (of gebruik de
-- dashboard-knop "Reload schema cache"), anders kent PostgREST de tabel nog niet
-- en falen zowel de website-read als de CRM-endpoints met "not in schema cache".
-- ============================================================================

create table if not exists public.website_quiz_publicaties (
  id                uuid primary key default gen_random_uuid(),
  slug              text not null,           -- quiz-slug ('7-daagse','student')
  versie            integer not null,        -- oplopend per slug
  naam              text not null,
  drempel           integer not null,
  inhoud            jsonb  not null,         -- [{ id, order_index, label,
                                             --    options:[{label,punten,afwijzer}] }]
  is_actueel        boolean not null default false,  -- de LIVE versie
  gepubliceerd_op   timestamptz not null default now(),
  gepubliceerd_door uuid                     -- auth.users.id (nullable)
);

-- Uniek versienummer per slug.
create unique index if not exists website_quiz_publicaties_slug_versie
  on public.website_quiz_publicaties (slug, versie);

-- Hard afdwingen: maar één actuele (live) versie per slug.
create unique index if not exists website_quiz_publicaties_een_actueel
  on public.website_quiz_publicaties (slug) where is_actueel;

-- ── RLS: aan, en de website-rol (anon) mag ALLEEN lezen ─────────────────────
alter table public.website_quiz_publicaties enable row level security;

drop policy if exists website_quiz_publicaties_anon_select on public.website_quiz_publicaties;
create policy website_quiz_publicaties_anon_select
  on public.website_quiz_publicaties
  for select
  to anon
  using (true);

-- Bewust GEEN insert/update/delete-policy: anon kan niet schrijven. De service
-- role bypasst RLS en verzorgt publiceren/rollback vanuit de CRM.

-- ── Eerste publicatie (versie 1) uit de huidige werk-versie ────────────────
insert into public.website_quiz_publicaties (slug, versie, naam, drempel, inhoud, is_actueel)
select
  q.slug, 1, q.naam, q.drempel,
  coalesce((
    select jsonb_agg(
             jsonb_build_object(
               'id',          qq.id,
               'order_index', qq.order_index,
               'label',       qq.label,
               'options',     qq.options
             )
             order by qq.order_index, qq.created_at
           )
    from public.website_quiz_questions qq
    where qq.quiz_id = q.id and qq.active
  ), '[]'::jsonb),
  true
from public.website_quizzes q
where q.is_active
  and not exists (select 1 from public.website_quiz_publicaties p where p.slug = q.slug);
