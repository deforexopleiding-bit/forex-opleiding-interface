-- Migratie 038 — Incasso pre-brief templates (PR-3)
--
-- Voegt een 'code'-kolom toe aan dunning_templates (uniek, meerdere NULLs OK)
-- en seedt 2 bewerkbare brief-templates:
--   * incasso_pre_nl  — NL WIK 14-dagenbrief
--   * incasso_pre_be  — BE eerste (kosteloze) herinnering, Boek XIX WER
--
-- ON CONFLICT (code) DO NOTHING → Jeffrey's latere edits worden niet
-- overschreven bij een tweede uitvoering.
-- Idempotent. Jeffrey draait handmatig.

alter table public.dunning_templates
  add column if not exists code text;

-- Volledige unieke index (zonder WHERE-predicaat): PostgreSQL staat
-- meerdere NULLs toe onder een gewone unieke index, dus bestaande
-- templates zonder code blijven geldig én ON CONFLICT (code) blijft
-- werken. Repo == DB (Jeffrey draaide de niet-partial versie).
create unique index if not exists ux_dunning_templates_code
  on public.dunning_templates (code);

-- ────────────────────────────────────────────────────────────────────
-- Seed: NL WIK 14-dagenbrief
-- ────────────────────────────────────────────────────────────────────
insert into public.dunning_templates (code, name, kind, subject, body, is_active)
values (
  'incasso_pre_nl',
  'Pre-incasso: WIK 14-dagenbrief (NL)',
  'brief',
  'Laatste aanmaning voor incasso',
  E'Geachte {{klant.naam}},\n\nUit onze administratie blijkt dat u nog een bedrag van {{klant.totaal_open}} openstaand heeft ter zake van openstaande facturen. Ondanks eerdere herinneringen hebben wij nog geen betaling van u ontvangen.\n\nHierbij sommeren wij u om het openstaande bedrag van {{klant.totaal_open}} binnen VEERTIEN (14) DAGEN na ontvangst van deze brief aan ons over te maken.\n\nAls de betaling niet binnen deze termijn is voldaan, zijn wij genoodzaakt de vordering uit handen te geven aan een incassobureau. In dat geval zullen buitengerechtelijke incassokosten (Besluit vergoeding voor buitengerechtelijke incassokosten, minimum EUR 40,00) en de wettelijke rente aan u in rekening worden gebracht.\n\nWij verzoeken u dringend het openstaande bedrag zo spoedig mogelijk over te maken naar het rekeningnummer zoals vermeld op de oorspronkelijke factuur, onder vermelding van het factuurnummer.\n\nMocht deze brief zich hebben gekruist met uw betaling, dan kunt u dit bericht als niet verzonden beschouwen.\n\nMet vriendelijke groet,\n\nDe Forex Opleiding NL B.V.',
  true
)
on conflict (code) do nothing;

-- ────────────────────────────────────────────────────────────────────
-- Seed: BE eerste (kosteloze) herinnering — Boek XIX WER
-- ────────────────────────────────────────────────────────────────────
insert into public.dunning_templates (code, name, kind, subject, body, is_active)
values (
  'incasso_pre_be',
  'Pre-incasso: eerste herinnering (BE)',
  'brief',
  'Eerste herinnering — openstaande factuur',
  E'Geachte {{klant.naam}},\n\nUit onze administratie blijkt dat wij nog een openstaand bedrag van {{klant.totaal_open}} van u tegoed hebben. Wij verzoeken u vriendelijk dit bedrag alsnog te voldoen.\n\nDeze eerste herinnering is KOSTELOOS.\n\nOvereenkomstig Boek XIX van het Wetboek van Economisch Recht (WER) heeft u een betaaltermijn van veertien (14) kalenderdagen te rekenen vanaf de derde werkdag na verzending van deze herinnering. Binnen deze termijn zijn geen kosten of interesten verschuldigd.\n\nIndien wij binnen deze wettelijke termijn geen betaling van u ontvangen, kunnen na afloop wettelijke schadevergoeding, verwijlinteresten en incassokosten in rekening worden gebracht conform de bepalingen van Boek XIX WER.\n\nWij verzoeken u het openstaande bedrag over te maken naar het rekeningnummer zoals vermeld op de oorspronkelijke factuur, onder vermelding van het factuurnummer.\n\nMocht deze herinnering zich hebben gekruist met uw betaling, dan kunt u dit bericht als niet verzonden beschouwen.\n\nMet vriendelijke groet,\n\nDe Forex Opleiding NL B.V.',
  true
)
on conflict (code) do nothing;

notify pgrst, 'reload schema';
