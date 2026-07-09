-- Migratie 030 — Events titels hernoemen naar "Forex Masterclass event Gent"
--
-- Doel: alle PUBLISHED events na 11 juli 2026 (starts_at >= 12 juli) krijgen
-- een uniforme, nette titel. Raakt uitsluitend het title-veld; webflow_item_id,
-- niveau, sync-status blijven ongemoeid (matching gebruikt geen titel-string).
--
-- Draaien in Supabase SQL editor. HANDMATIG na review van de select-preview.

-- 1) Preview vóór de update — bekijk welke rijen geraakt worden:
select id, title, starts_at::date, status
from events
where status = 'published'
  and starts_at >= '2026-07-12 00:00:00+00'
order by starts_at;

-- 2) Update (draai pas nadat de preview klopt):
update events
   set title = 'Forex Masterclass event Gent'
 where status = 'published'
   and starts_at >= '2026-07-12 00:00:00+00';

-- 3) PostgREST schema-reload zodat gecachte kolomindexen refreshen:
notify pgrst, 'reload schema';

-- 4) Verificatie na de update — toon alle published events + titel + datum:
select id, title, starts_at::date, status
from events
where status = 'published'
order by starts_at;
