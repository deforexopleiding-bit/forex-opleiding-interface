-- 2026-09-08 · Testrijen apart houden in de opvolgmodule
--
-- WAAROM EEN VLAG EN GEEN FILTER OP TEKST.
-- Er zitten drie verschillende dingen in de data:
--   1. een taak die overduidelijk nep is ('test test2', test@gmail.com);
--   2. een taak op een echte naam en een echt nummer, als proefkaart gebruikt;
--   3. een POGING met resultaat 'gesproken: test' op een ECHTE lead.
--
-- Geval 3 sluit de makkelijke oplossingen uit. Filteren op de naam van de lead
-- mist hem, want de kaart is echt. Filteren op het woord 'test' in de
-- resultaattekst is tekstherkenning, en die breekt zodra iemand een notitie
-- schrijft waar 'test' in staat — dan verdwijnt er ECHT werk uit de cijfers.
-- Een verdwijnende belpoging is erger dan een testrij die meetelt.
--
-- NOT NULL DEFAULT FALSE is bewust: alles wat er nu staat telt vanzelf gewoon
-- mee, en er verdwijnt niets stilletjes op het moment dat dit draait.
--
-- DEZE MIGRATIE IS NIET BLOKKEREND. De code noemt is_test wel bij naam in de
-- SELECT, maar valt bij fout 42703 terug op een select zonder die kolom (zie
-- api/_lib/opvolging-testrijen.js). Draai je hem voor of na de deploy: in
-- allebei de volgordes blijft het rapport werken. Zolang de kolom er niet is
-- meldt het rapport onder het volumeblok dat testrijen nog niet apart gehouden
-- worden.

alter table opvolging_taken
  add column if not exists is_test boolean not null default false;

alter table opvolging_pogingen
  add column if not exists is_test boolean not null default false;

-- Alleen de testrijen wegen mee in een index; de rest is de normale situatie.
create index if not exists idx_opvolging_taken_is_test
  on opvolging_taken (is_test) where is_test;
create index if not exists idx_opvolging_pogingen_is_test
  on opvolging_pogingen (is_test) where is_test;

-- ── NA HET DRAAIEN: de drie bekende gevallen markeren ──────────────────────
-- Bewust APART en niet automatisch: welke rij een testrij is, is een besluit
-- van een mens. Controleer eerst met de select, druk dan pas op de update.
--
--   select id, naam, telefoon from opvolging_taken
--    where naam ilike '%test%' or telefoon is null;
--
--   select p.id, p.resultaat, t.naam
--     from opvolging_pogingen p join opvolging_taken t on t.id = p.taak_id
--    where p.resultaat ilike '%test%';
--
-- En daarna, per gecontroleerde id:
--   update opvolging_taken    set is_test = true where id = '...';
--   update opvolging_pogingen set is_test = true where id = '...';
