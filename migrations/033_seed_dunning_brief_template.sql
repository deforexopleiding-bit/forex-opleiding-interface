-- Migratie 033 — seed standaard aanmaanbrief-template
--
-- Idempotent: alleen INSERT als er nog geen brief-template met de vaste
-- seed-naam bestaat. Jeffrey kan de body via de UI aanpassen zonder dat
-- de seed 'm bij een re-run overschrijft.
--
-- Vereist: migratie 032 (kind='brief' toegevoegd aan CHECK-constraint).

insert into public.dunning_templates (name, kind, subject, body, is_active)
select
  'Standaard aanmaanbrief',
  'brief',
  'Betalingsherinnering',
  E'Geachte heer/mevrouw {{klant.achternaam}},\n\n' ||
  E'Uit onze administratie blijkt dat er op dit moment {{klant.aantal_open}} factu(u)r(en) openstaan met een totaalbedrag van {{klant.totaal_open}}. Het betreft:\n\n' ||
  E'{{klant.factuur_lijst}}\n\n' ||
  E'Wij verzoeken u vriendelijk doch dringend het openstaande bedrag binnen 14 dagen te voldoen. Heeft u vragen of wilt u een betalingsregeling treffen, neem dan contact met ons op.\n\n' ||
  E'Met vriendelijke groet,\n' ||
  E'De Forex Opleiding',
  true
where not exists (
  select 1 from public.dunning_templates
   where kind = 'brief'
     and name = 'Standaard aanmaanbrief'
);

notify pgrst, 'reload schema';
