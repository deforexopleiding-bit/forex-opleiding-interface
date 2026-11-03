# Dry-run handmatige trajecten → factuurmotor (gemeten 3 nov 2026)

Bron: productiedatabase, alleen lees-queries. Regel (Maxim): **enkel een betaalde
factuur geeft commissie vrij**. Doel = commissie × betaald / basis (3 % van
het betaalde bedrag, gedeeld door het aantal aanwezige mentoren).
"Werkelijk uitbetaald" = in een rapport dat uitbetaald is, of in een rapport
juni–september 2026 dat nog op *goedgekeurd* staat maar volgens Maxim betaald
is (verschil status ↔ werkelijkheid apart).

## Per klant

| Klant | Sale (deal) | Basis | Betaald in CRM | Mentoren | Commissie p.m. | Doel p.m. |
|---|---|---|---|---|---|---|
| Paul Plantfeber | e8a55d0f (21 mrt) — **te controleren** | 4 200,00 | 1 600,00 | Seppe | 126,00 | 48,00 |
| Mohammad Shoaib Shaliwal | ced18cac (8 apr) | 7 200,00 | 440,00 ¹ | Seppe, Danny | 108,00 | 6,60 |
| Noorulhaq Alikozai | 9c8a03c6 (4 apr) | 7 200,00 | 400,00 | Seppe, Danny | 108,00 | 6,00 |

¹ Factuur 2026/835 staat op 440 betaald bij een factuurbedrag van 400. De
factuurmotor telt wat betaald is (440). Rekenen op 400 geeft 6,00 p.m. Te
controleren.

## Per mentor

| Klant · mentor | Vrijgegeven | Werkelijk uitbetaald | waarvan status nog "goedgekeurd" | Vrijgegeven, in geen rapport | Doel | Te veel vrijgegeven | Te veel uitbetaald |
|---|---|---|---|---|---|---|---|
| Paul · Seppe | 91,60 | 45,80 | 45,80 | 45,80 | 48,00 | 43,60 | 0,00 (nog 2,20 tegoed) |
| Shaliwal · Seppe | 42,00 | 24,00 | 24,00 | 18,00 | 6,60 | 35,40 | 17,40 |
| Shaliwal · Danny | 42,00 | 24,00 | 24,00 | 18,00 | 6,60 | 35,40 | 17,40 |
| Noorulhaq · Seppe | 42,00 | 24,00 | 24,00 | 18,00 | 6,00 | 36,00 | 18,00 |
| Noorulhaq · Danny | 42,00 | 24,00 | 24,00 | 18,00 | 6,00 | 36,00 | 18,00 |
| **Totaal** | **259,60** | **141,80** | **141,80** | **117,80** | **73,20** | **186,40** | **70,80** |

Status in de database: 0,00 uitbetaald. Werkelijkheid: 141,80 uitbetaald
(rapporten juni–september). Het verschil is precies die 141,80.

## Wat de factuurmotor na omzetting doet

* Grootboek: per mentor een parent met de oorspronkelijke commissie; de 36
  termijnregels worden er children van (bedragen, status, payout_id ongewijzigd).
  De motor rekent "reeds vrijgegeven" = som van de children → **0,00 vrij** voor
  alle vijf (`no_delta`) tot de betalingen het vrijgegeven bedrag inhalen.
* Rapport/overzicht: termijnregels die al in een rapport zitten (141,80) staan in
  hun eigen maand en tellen als al vergoed; betaalde termijnen tellen pas voor
  het deel daarboven. De 117,80 die **in geen rapport** zit gaat niet alsnog naar
  een rapport (geen betaalde factuur). Beslissing Maxim: annuleren (voorstel B in
  `docs/sql-migrations/2026-11-03-VOORSTEL-rapporten-juni-september-uitbetaald.sql`)
  of laten staan.
* Paul: het overzicht rekent per betaalde termijn (12,44 op basis van het
  abonnement van 414,68 incl. btw; de facturen zijn 400). Bij 4 betaalde
  termijnen is dat 49,76 tegenover 45,80 in rapporten, dus 3,96 in het rapport
  van november. De factuurmotor rekent op het bedrag (48,00) en geeft in het
  grootboek niets vrij (91,60 > 48,00). Dat verschil tussen termijntelling en
  bedrag bestond al. Paul is sowieso te controleren: zijn betalingen in
  GoHighLevel staan niet in het CRM.

## Te controleren door Maxim

1. **Paul Plantfeber**: betalingen in GoHighLevel zijn niet zichtbaar in het CRM.
   Welke betalingen ontbreken? Klopt de sale van 21 maart (twee getekende deals)?
2. **Shaliwal 2026/835**: 440 betaald op 400.
3. **Shaliwal 2026/2136** (6 760,00, open sinds 26 okt, geen deal of abonnement):
   regeling of incassofactuur? Als dit de factuur voor het bureau is, hoort ze in
   concept te staan (telt dan nooit mee).
4. **Noorulhaq**: alles na mei is gecrediteerd (ook 2026/2135 van 6 800,00). Er staat
   geen open factuur meer. Pipeline: 8 okt via `auto:overdue` in "nieuw" gezet.
