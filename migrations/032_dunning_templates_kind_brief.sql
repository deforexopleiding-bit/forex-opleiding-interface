-- Migratie 032 — dunning_templates.kind uitbreiden met 'brief'
--
-- Nieuwe kind 'brief' voor printbare PDF-aanmaanbrieven (per post). De
-- bestaande CHECK-constraint accepteert alleen 'email'|'whatsapp' →
-- DROP + ADD met de nieuwe waarde. Idempotent: als de constraint niet
-- bestaat, wordt de DROP gewoon een no-op via IF EXISTS.
--
-- Jeffrey draait 'm handmatig. GEEN downtime — de tabel wordt niet
-- herschreven, alleen de check-constraint muteert.

do $$
declare
  cname text;
begin
  select conname into cname
    from pg_constraint
   where conrelid = 'public.dunning_templates'::regclass
     and contype  = 'c'
     and pg_get_constraintdef(oid) ilike '%kind%';
  if cname is not null then
    execute format('alter table public.dunning_templates drop constraint %I', cname);
  end if;
end $$;

alter table public.dunning_templates
  add constraint dunning_templates_kind_check
  check (kind in ('email', 'whatsapp', 'brief'));

notify pgrst, 'reload schema';
