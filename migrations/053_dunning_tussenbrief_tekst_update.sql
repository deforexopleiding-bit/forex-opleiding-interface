-- Migratie 053 - Tussenbrief-tekst bijwerken (incasso_tussen_nl + incasso_tussen_be)
--
-- Werkt de VRIENDELIJKE tussenbrief bij naar de definitieve tekst. Omdat de
-- factuur-PDF-bijlage is teruggedraaid, belooft de brief geen bijlage meer; in
-- plaats daarvan staat het expliciete IBAN-rekeningnummer in de brief en wordt
-- om betaling binnen 7 dagen gevraagd. De {{klant.factuur_lijst}}-variabele
-- blijft (lijst van openstaande facturen in de brieftekst zelf).
--
-- UPDATE (geen insert): de rijen bestaan al via migratie 052. 052 gebruikt
-- ON CONFLICT (code) DO NOTHING, dus een her-insert zou niets overschrijven.
-- Deze UPDATE zet subject + body voor BEIDE codes (NL en BE identiek).
-- Idempotent: opnieuw draaien zet dezelfde tekst. Jeffrey draait handmatig.

update public.dunning_templates
set
  subject = 'Een vriendelijke herinnering aan je openstaande betaling',
  body =
    E'Beste {{klant.voornaam}},\n\n' ||
    E'Volgens onze administratie staat er nog een betaling van je open. Waarschijnlijk is het je even ontschoten, dat gebeurt zo. Bij deze daarom een vriendelijke herinnering.\n\n' ||
    E'Het gaat om het volgende openstaande bedrag: {{klant.totaal_open}}.\n\n' ||
    E'Dit betreft de volgende factu(u)r(en):\n\n' ||
    E'{{klant.factuur_lijst}}\n\n' ||
    E'Zou je dit bedrag binnen 7 dagen na ontvangst van deze brief willen overmaken op onderstaand rekeningnummer, onder vermelding van het factuurnummer?\n\n' ||
    E'De Forex Opleiding B.V.\n' ||
    E'IBAN: NL53INGB0101659334\n\n' ||
    E'Lukt het nu even niet om alles in één keer te betalen? Geen zorgen, laat het ons gewoon weten. We denken graag met je mee en kijken samen naar een passende oplossing. Je kunt ons bereiken via administratie@deforexopleiding.nl.\n\n' ||
    E'We sturen je deze herinnering nu bewust, omdat we willen voorkomen dat we de vordering later uit handen moeten geven aan een incassobureau. Daar komen namelijk extra incassokosten bij kijken, en die besparen we je natuurlijk veel liever. Door nu te betalen of even contact op te nemen, is dat helemaal niet nodig.\n\n' ||
    E'Heb je inmiddels al betaald? Dan kun je deze herinnering als niet verzonden beschouwen, en danken we je hartelijk.\n\n' ||
    E'Met vriendelijke groet,\n\n' ||
    E'Jeffrey Biemold\n' ||
    E'CEO - De Forex Opleiding'
where code in ('incasso_tussen_nl', 'incasso_tussen_be');
