-- PROJECT: crm
--
-- 2026-10-15-opvolging-lab-bellen.sql — de belmelding van The Lab
--
-- WAAROM
-- ------
-- cron-lab-belmelding zet een belopdracht bovenaan Daves Opvolging zodra een
-- lab-lead warm is (Lab af en niet geboekt, wil investeren, 24u stil na stap 5,
-- of vroeg zelf "bel me"). Daarvoor:
--   1. een nieuwe reden 'lab_bellen' in de CHECK op opvolging_taken.reden
--      (de oude lijst blijft volledig geldig — er komt er één bij);
--   2. één taak per lab-lead per belreden, door de databank bewaakt: een
--      partiële unieke index op (bron_ref->>'lab_lead_id', reden_code).
--
-- Additief: geen rij wordt aangeraakt, geen kolom verdwijnt. Het vervangen van
-- de CHECK gebeurt in één transactie (één statement-blok hieronder is genoeg;
-- de Supabase-editor knipt op statements, dus elk statement staat op zich en
-- is apart veilig).
--
-- Rollback (alleen als het echt moet en er geen lab_bellen-rijen zijn):
--   drop index if exists public.opvolging_taken_lab_bellen_uniek;
--   alter table public.opvolging_taken drop constraint opvolging_taken_reden_chk;
--   alter table public.opvolging_taken add constraint opvolging_taken_reden_chk
--     check (reden = any (array['wil_nog_beslissen','no_show_event','no_show_call','afgemeld',
--       'niet_ingepland','aanmelding','zoom_nabellen','zoom_geannuleerd','zoom_bevestigen','lead_bellen']));

-- Controle VÓÓR — verwacht: lab_bellen ontbreekt in de check, index bestaat niet.
select pg_get_constraintdef(oid) as reden_check from pg_constraint
 where conrelid = 'public.opvolging_taken'::regclass and conname = 'opvolging_taken_reden_chk';

alter table public.opvolging_taken drop constraint if exists opvolging_taken_reden_chk,
  add constraint opvolging_taken_reden_chk check (reden = any (array[
    'wil_nog_beslissen','no_show_event','no_show_call','afgemeld','niet_ingepland','aanmelding',
    'zoom_nabellen','zoom_geannuleerd','zoom_bevestigen','lead_bellen','lab_bellen']::text[]));

create unique index if not exists opvolging_taken_lab_bellen_uniek
  on public.opvolging_taken ((bron_ref->>'lab_lead_id'), reden_code)
  where reden = 'lab_bellen';

-- Controle NA — verwacht: lab_bellen in de check, en de index.
select pg_get_constraintdef(oid) as reden_check from pg_constraint
 where conrelid = 'public.opvolging_taken'::regclass and conname = 'opvolging_taken_reden_chk';
select indexname from pg_indexes where tablename = 'opvolging_taken' and indexname = 'opvolging_taken_lab_bellen_uniek';
