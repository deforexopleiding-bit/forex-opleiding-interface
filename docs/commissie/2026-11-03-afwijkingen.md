# Huidige afwijkingen mentorcommissie (gemeten 3 nov 2026)

Bron: productiedatabase, alleen lees-queries, vóór de migraties van PR 1–3.
"Zou moeten zijn" = factuurmotor: commissie × betaald op de facturen van de
sale / basis (per mentor, nooit boven de oorspronkelijke commissie). Na deploy
toont **Mentoren › Commissies › Controle** dit live, inclusief de rapportkant
(wat het mentorrapport uitkeert) en per sale de facturen.

## 1. Te veel vrijgegeven — de drie handmatige trajecten

| Traject · mentor | Vrijgegeven | Werkelijk uitbetaald | In geen rapport | Zou moeten zijn | Te veel |
|---|---|---|---|---|---|
| Paul Plantfeber · Seppe | 91,60 | 45,80 | 45,80 | 48,00 | 43,60 |
| Mohammad Shoaib Shaliwal · Seppe | 42,00 | 24,00 | 18,00 | 6,60 | 35,40 |
| Mohammad Shoaib Shaliwal · Danny | 42,00 | 24,00 | 18,00 | 6,60 | 35,40 |
| Noorulhaq Alikozai · Seppe | 42,00 | 24,00 | 18,00 | 6,00 | 36,00 |
| Noorulhaq Alikozai · Danny | 42,00 | 24,00 | 18,00 | 6,00 | 36,00 |
| **Totaal** | **259,60** | **141,80** | **117,80** | **73,20** | **186,40** |

Oplossing: PR 1 (omzetten + verrekening). Details in `2026-11-03-dryrun-trajecten.md`.
Beslissing Maxim (3 nov): de 117,80 in geen rapport wordt **geannuleerd** —
`docs/sql-migrations/2026-11-03-trajecten-annuleren-niet-in-rapport.sql` (na de omzetting).

## 2. Sale zonder commissie

Geen. De eerder gemelde Jimco Schepens (Forex Masterclass Gent 23-09) is een
**annulatie** (beslissing Maxim 3 nov): offerte gearchiveerd op 29-10, abonnement
en onboarding geannuleerd, factuur 2026/5020 gecrediteerd. Geen commissie en geen
nakijkpunt; zijn gegevens zijn niet aangeraakt. Het controlescherm toont een
gearchiveerde offerte nooit als "sale zonder commissie" (getest).

## 3. Grootboek loopt achter (doel > vrijgegeven in het grootboek)

De factuurmotor heeft voor deze klanten nog niet gedraaid op hun betaalde
facturen. Het **mentorrapport rekent op de facturen** (computeBonusOverview),
niet op het grootboek. De mentor krijgt dit dus via het rapport; het grootboek is
audit. Na PR 4 draait de motor bij elke geregistreerde betaling. Een eenmalige
inhaalrun kan via `/api/admin/bonus-release-sync` (mode amount, eerst dry-run).

| Klant | Event | Betaald | Zou moeten zijn | Grootboek | Achter |
|---|---|---|---|---|---|
| BV Ky | Chesney + Seppe | 3 200,00 | 96,00 | 0,00 | 96,00 |
| Stéphane Seutin | Forex Masterclass Gent | 2 966,66 | 89,00 | 0,00 | 89,00 |
| Jef Van Laeken | seppe + kjento | 2 000,00 | 60,00 | 12,00 | 48,00 |
| Richiano Blondiau | seppe + kjento | 1 300,00 | 39,00 | 0,00 | 39,00 |
| Dominique Houthuijzen | Chesney + Seppe | 1 500,00 | 45,00 | 9,00 | 36,00 |
| Younes Jkaoua | Chesney + Seppe | 1 500,00 | 45,00 | 9,00 | 36,00 |
| Cedric Van Houtte | Danny solo | 5 330,00 | 159,90 | 127,98 | 31,92 |
| Peter Dezuttere | Forex Masterclass Gent | 1 000,00 | 30,00 | 0,00 | 30,00 |
| Annelies De Brouwere | Danny solo | 900,00 | 27,00 | 0,00 | 27,00 |
| Kevin Zhang | seppe + danny | 480,00 | 14,40 | 4,80 | 9,60 |
| Miguel Claeys | Forex Masterclass Gent | 160,00 | 4,80 | 0,00 | 4,80 |
| **Totaal** | | | **610,10** | **162,78** | **447,32** |

Geen enkele gewone sale heeft te veel vrijgegeven in het grootboek. Gregory De Rubbel
klopt exact (7,40). Bij 9 sales is nog niets betaald, dus doel 0 = grootboek 0.

## 4. Status tegenover werkelijkheid — rapporten juni t/m september

23 rapporten staan op **goedgekeurd** terwijl ze volgens Maxim betaald zijn. Hun
grootboekregels staan op vrijgegeven. De knop "Markeer uitbetaald" kan ze niet
afsluiten: hij faalt op elk van die rapporten met `bonus_drift`. Beslissing Maxim (3 nov): op uitbetaald —
`docs/sql-migrations/2026-11-03-rapporten-juni-september-uitbetaald.sql`
(definitief, niet door mij gedraaid). Daarnaast staat Seppe april 2026 nog op goedgekeurd (bonus 0,00); dat
rapport noemde Maxim niet.

## 5. Facturen en klanten om te controleren

- **Shaliwal 2026/835**: 440 betaald op 400 (40 te veel). De motor telt 440.
- **Shaliwal 2026/2136** (6 760, zonder deal of abonnement) is de **bureaufactuur** en blijft open
  (beslissing Maxim 3 nov); bij een regeling crediteert Maxim ze zelf. Met de klant op *bij incasso*
  krijgt ze geen aanmaning en geeft ze geen commissie (getest in PR 4).
- **Paul Plantfeber**: betalingen in GoHighLevel staan niet in het CRM. Er zijn twee getekende deals.
- **Dany Brice Iradukunda**: de sale is geannuleerd (commissie 0, correct), maar factuur 2026/1320
  van 1 185 is **betaald** op 12-07. Terugbetaling of een andere sale?
- **Dominik Rowgalo en Laye Conde**: de commissie-sale is een **gearchiveerde** getekende offerte;
  hun abonnementen zijn geannuleerd en er is niets betaald.
- **15 abonnementen zonder soort** bij commissieklanten (zie `2026-11-03-soort-abonnement.md`),
  geen enkele met een betaalde factuur.
