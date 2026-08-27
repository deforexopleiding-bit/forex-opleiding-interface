-- migrations/048_dunning_bulk_jobs_brief_channel.sql
--
-- Voegt 'brief_only' toe aan de channel-check van dunning_bulk_jobs zodat
-- bulk-"Brief aanmaken" (Wanbetalers → Overzicht) een expliciete kanaal-
-- waarde krijgt. NIET 'email' hergebruiken als placeholder — vervuilt
-- rapportage, leest als e-mailsend.
--
-- Veilig op bestaande rijen: nieuwe check is SUPERSET van oude
-- ('whatsapp','email','both','brief_only'). Idempotent — kan meerdere
-- keren gedraaid worden zonder effect.
--
-- ⚠️  VOOR HET DRAAIEN — bevestig eerst constraint-namen:
--
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid='public.dunning_bulk_jobs'::regclass and contype='c';
--
-- Verwacht: check-constraint met tekst 'channel = ANY (...)'. Naam is
-- meestal 'dunning_bulk_jobs_channel_check' maar kan afwijken. Dit script
-- vindt de check dynamisch via pg_constraint-scan i.p.v. hardcoded naam.

begin;

do $$
declare
  r record;
  drop_sql text;
begin
  for r in
    select c.conname
    from   pg_constraint c
    join   pg_attribute a
             on a.attrelid = c.conrelid
            and a.attnum   = any(c.conkey)
    where  c.conrelid = 'public.dunning_bulk_jobs'::regclass
      and  c.contype  = 'c'
      and  a.attname  = 'channel'
  loop
    drop_sql := format('alter table public.dunning_bulk_jobs drop constraint %I', r.conname);
    raise notice 'Dropping constraint: %', r.conname;
    execute drop_sql;
  end loop;
end $$;

alter table public.dunning_bulk_jobs
  add constraint dunning_bulk_jobs_channel_check
  check (channel in ('whatsapp','email','both','brief_only'));

commit;

-- ── VERIFICATIE (draai los, na commit) ─────────────────────────────────
--
-- select conname, pg_get_constraintdef(oid) as def
-- from pg_constraint
-- where conrelid = 'public.dunning_bulk_jobs'::regclass
--   and conname = 'dunning_bulk_jobs_channel_check';
--
-- Verwacht 1 rij, def bevat 'brief_only'.
--
-- Sanity — geen bestaande rijen die de nieuwe check breken:
-- select channel, count(*) from public.dunning_bulk_jobs
-- where channel not in ('whatsapp','email','both','brief_only')
-- group by channel;
