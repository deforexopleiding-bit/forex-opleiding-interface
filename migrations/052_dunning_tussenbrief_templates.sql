-- Migratie 052 - Incasso tussenbrief-templates (vriendelijke herinnering)
--
-- Voegt twee bewerkbare brief-templates toe aan dunning_templates:
--   * incasso_tussen_nl - vriendelijke tussenbrief (NL)
--   * incasso_tussen_be - vriendelijke tussenbrief (BE, nu identiek aan NL;
--                         Jeffrey past later aan)
--
-- Deze tussenbrief is bedoeld VÓÓR de bestaande WIK 14-dagenbrief
-- (incasso_pre_nl / incasso_pre_be) in de reeks. Hij vervangt de wettelijke
-- WIK-brief NIET - die blijft verplicht vóór incassokosten bij consumenten.
--
-- Vereist: migratie 038 (kolom `code` + unieke index op dunning_templates.code).
-- ON CONFLICT (code) DO NOTHING → latere edits via de UI blijven behouden bij
-- een re-run. Idempotent. Jeffrey draait handmatig.

insert into public.dunning_templates (code, name, kind, subject, body, is_active)
values (
  'incasso_tussen_nl',
  'Tussenbrief: vriendelijke herinnering (NL)',
  'brief',
  'Een vriendelijke herinnering aan je openstaande betaling',
  E'Beste {{klant.voornaam}},\n\n' ||
  E'Volgens onze administratie staat er nog een betaling van je open. Waarschijnlijk is het je even ontschoten, dat gebeurt zo. Bij deze daarom een vriendelijke herinnering.\n\n' ||
  E'Het gaat om het volgende openstaande bedrag: {{klant.totaal_open}}.\n\n' ||
  E'{{klant.factuur_lijst}}\n\n' ||
  E'De bijbehorende factuur hebben we voor je gemak als bijlage bij deze e-mail toegevoegd, zodat je alles meteen bij de hand hebt.\n\n' ||
  E'Zou je dit bedrag binnen 14 dagen willen overmaken op het rekeningnummer zoals vermeld op de oorspronkelijke factuur, onder vermelding van het factuurnummer?\n\n' ||
  E'Lukt het nu even niet om alles in een keer te betalen? Geen zorgen, laat het ons gewoon weten. We denken graag met je mee en kijken samen naar een passende oplossing. Je kunt ons bereiken via administratie@deforexopleiding.nl.\n\n' ||
  E'We sturen je deze herinnering nu bewust, omdat we willen voorkomen dat we de vordering later uit handen moeten geven aan een incassobureau. Daar komen namelijk extra incassokosten bij kijken, en die besparen we je natuurlijk veel liever. Door nu te betalen of even contact op te nemen, is dat helemaal niet nodig.\n\n' ||
  E'Heb je inmiddels al betaald? Dan kun je deze herinnering als niet verzonden beschouwen, en danken we je hartelijk.\n\n' ||
  E'Met vriendelijke groet,\n\n' ||
  E'Jeffrey Biemold\n' ||
  E'CEO - De Forex Opleiding',
  true
)
on conflict (code) do nothing;

insert into public.dunning_templates (code, name, kind, subject, body, is_active)
values (
  'incasso_tussen_be',
  'Tussenbrief: vriendelijke herinnering (BE)',
  'brief',
  'Een vriendelijke herinnering aan je openstaande betaling',
  E'Beste {{klant.voornaam}},\n\n' ||
  E'Volgens onze administratie staat er nog een betaling van je open. Waarschijnlijk is het je even ontschoten, dat gebeurt zo. Bij deze daarom een vriendelijke herinnering.\n\n' ||
  E'Het gaat om het volgende openstaande bedrag: {{klant.totaal_open}}.\n\n' ||
  E'{{klant.factuur_lijst}}\n\n' ||
  E'De bijbehorende factuur hebben we voor je gemak als bijlage bij deze e-mail toegevoegd, zodat je alles meteen bij de hand hebt.\n\n' ||
  E'Zou je dit bedrag binnen 14 dagen willen overmaken op het rekeningnummer zoals vermeld op de oorspronkelijke factuur, onder vermelding van het factuurnummer?\n\n' ||
  E'Lukt het nu even niet om alles in een keer te betalen? Geen zorgen, laat het ons gewoon weten. We denken graag met je mee en kijken samen naar een passende oplossing. Je kunt ons bereiken via administratie@deforexopleiding.nl.\n\n' ||
  E'We sturen je deze herinnering nu bewust, omdat we willen voorkomen dat we de vordering later uit handen moeten geven aan een incassobureau. Daar komen namelijk extra incassokosten bij kijken, en die besparen we je natuurlijk veel liever. Door nu te betalen of even contact op te nemen, is dat helemaal niet nodig.\n\n' ||
  E'Heb je inmiddels al betaald? Dan kun je deze herinnering als niet verzonden beschouwen, en danken we je hartelijk.\n\n' ||
  E'Met vriendelijke groet,\n\n' ||
  E'Jeffrey Biemold\n' ||
  E'CEO - De Forex Opleiding',
  true
)
on conflict (code) do nothing;

notify pgrst, 'reload schema';
