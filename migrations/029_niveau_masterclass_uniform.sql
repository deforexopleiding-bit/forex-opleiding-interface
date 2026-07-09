-- 029_niveau_masterclass_uniform.sql
--
-- Blok C — Aanpak A: één uniform event-type 'Masterclass event in Gent'.
-- 'basis'/'gevorderd' worden onzichtbaar gemaakt (is_active=false) i.p.v.
-- verwijderd, zodat de scoring intern nog kan draaien (routing_result +
-- copy_tier worden nog berekend en opgeslagen) maar geen keuze meer stuurt.
--
-- Kolommen (bevestigd via events-niveau-options.js): slug (PK), label,
-- sort_order, is_active, default_image_url.

insert into event_niveau_options (slug, label, sort_order, is_active)
values ('masterclass', 'Masterclass event in Gent', 0, true)
on conflict (slug) do update set
  label      = excluded.label,
  is_active  = true,
  sort_order = 0;

update event_niveau_options
   set is_active = false
 where slug in ('basis', 'gevorderd');

-- Bestaande events omzetten naar de nieuwe uniforme optie zodat de
-- niveau_label-join in events-list / events-detail netjes
-- 'Masterclass event in Gent' toont.
update events
   set niveau = 'masterclass'
 where niveau in ('basis', 'gevorderd');

-- Verificatie-queries (draai apart om te bevestigen):
-- select slug, label, is_active from event_niveau_options order by sort_order;
-- select count(*) filter (where niveau='masterclass') as mc,
--        count(*) filter (where niveau in ('basis','gevorderd')) as legacy
--   from events;
-- (Verwacht: legacy=0, mc = totaal aantal events.)

notify pgrst, 'reload schema';
