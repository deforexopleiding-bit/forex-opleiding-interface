-- ─────────────────────────────────────────────────────────────────────────────
-- Taak 6, deel 2b — één OPEN rij per persoon, afgedwongen door het schema
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ DRAAI DIT PAS NÁ DE MERGE VAN DE BIJBEHORENDE CODE.
--
-- Tot nu toe deden twee plekken een gewone INSERT in `iris_belrij`:
-- `api/iris-actie.js` (de actie belrij_toevoegen uit een plan) en
-- `api/iris-belrij.js` (de knop op het scherm). Beide maakten een NIEUWE rij,
-- ook als die persoon er al op stond. De code van deel 2b laat ze allebei langs
-- voegHandmatigToe() lopen, die eerst kijkt of er al een open rij is.
--
-- Draait deze index VOORDAT die code live staat, dan begint elke handmatige
-- toevoeging voor iemand die al op de lijst staat te falen met 23505 — en dat
-- is een foutmelding op het scherm waar eerst een dubbele rij stond. Andersom
-- (code eerst, index later) is er geen moment waarop iets stuk is: de code
-- maakt dan al geen dubbele rijen meer, de index bevestigt het alleen.
--
-- ADDITIEF en omkeerbaar: één index erbij, verder niets. Geen DROP, geen
-- hernoemen, geen UPDATE op bestaande rijen.
--
-- DRAAIEN: losse statements in de Supabase SQL-editor.


-- ── CONTROLE VOOR — LEES DIT EERST ───────────────────────────────────────────
-- `personen_dubbel` moet 0 zijn, anders faalt stap 1 (een unieke index kan niet
-- op gegevens die hem al breken). Staat er iets boven 0, draai stap 1 dan NIET
-- en laat het me weten: welke van de twee rijen weg of samengevoegd moet, is
-- een inhoudelijke keuze over werk dat iemand misschien al heeft opgepakt. Die
-- maak ik niet voor je.

select
  (select count(*) from public.iris_belrij where status in ('open','bezig'))  as open_rijen,
  (select count(*) from (
     select contact_id from public.iris_belrij
     where status in ('open','bezig')
     group by contact_id having count(*) > 1
   ) d)                                                                       as personen_dubbel;

-- En wie dat dan zijn, zodat je het kunt bekijken voor je iets besluit.
-- Geen namen en geen nummers: alleen id's en aantallen.
select contact_id, count(*) as rijen, min(aangemaakt_op) as oudste, max(aangemaakt_op) as nieuwste
from public.iris_belrij
where status in ('open','bezig')
group by contact_id
having count(*) > 1
order by count(*) desc, max(aangemaakt_op) desc;


-- ── 1. De index ──────────────────────────────────────────────────────────────
-- Partieel: alleen op rijen die nog werk zijn. Een persoon die vorig jaar
-- gebeld is (status 'gedaan') mag er vandaag weer op, en dat moet ook kunnen.
--
-- NB: deze index kan GEEN ON CONFLICT-arbiter zijn in PostgREST/supabase-js —
-- partiële indexen mogen dat niet. Daarom blijft de code werken met
-- SELECT-dan-UPDATE-of-INSERT; de index is het vangnet eronder, niet de weg.

create unique index if not exists idx_iris_belrij_een_open_per_contact
  on public.iris_belrij (contact_id) where status in ('open','bezig');

comment on index public.idx_iris_belrij_een_open_per_contact is
  'Taak 6: één open belrij-rij per persoon. Twee rijen betekent twee keer gebeld worden. De redenen hangen in iris_belrij_redenen, dus meerdere redenen passen op één rij.';


-- ── CONTROLE NA ──────────────────────────────────────────────────────────────
-- Verwacht: bestaat = 1, is_uniek = true.

select
  indexname,
  indexdef like '%UNIQUE%' as is_uniek
from pg_indexes
where schemaname = 'public'
  and tablename = 'iris_belrij'
  and indexname = 'idx_iris_belrij_een_open_per_contact';


-- ── TERUGDRAAIEN ─────────────────────────────────────────────────────────────
-- Een index weghalen raakt geen gegevens. Veilig, altijd.
--
--   drop index if exists public.idx_iris_belrij_een_open_per_contact;
