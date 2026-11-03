# Soort abonnement — backfillvoorstel en te beslissen gevallen (3 nov 2026)

Regel (Maxim): origineel, aanpassing (uitstel / lager bedrag / regeling) en
incasso-regeling blijven bij dezelfde sale, met de oorspronkelijke commissie
als maximum. Een nieuwe offerte telt nooit mee voor een oude event-bonus,
tenzij toegewezen. Dit vervangt het klantbreed optellen in de factuurmotor en
de 92-dagenregel in `maakSaleScope`, in engine, overzicht en rapport.

## Backfill (migratie `2026-11-03-subscriptions-soort.sql`, stap 3)

| Voorstel | Aantal | Lopend | Zeker? |
|---|---|---|---|
| origineel — geïmporteerd, één getekende sale, start ≤ 92 d | 478 | 92 | ja |
| origineel — eigen getekende offerte | 99 | 82 | ja |
| nieuwe_offerte — eigen getekende offerte, eerdere sale bestaat | 14 | 11 | ja |
| start > 92 d na tekenen (uitstel, regeling of nieuwe offerte?) | 360 | 115 | **nee** |
| meerdere getekende sales vóór de start | 196 | 92 | **nee** |
| geen getekende sale vóór de start | 137 | 0 | **nee** |
| offerte niet getekend of gearchiveerd | 19 | 1 | **nee** |

Zeker: 591 worden gevuld. Onduidelijk: 712 blijven leeg. Overgangsregel voor
een abonnement zonder soort: de oude regel, en vindt die niets, dan de enige
commissie-sale van de klant. Zo valt er niets weg wat vandaag meetelt.

## Impact op de huidige commissie (gemeten)

Geen. Alle 22 commissieklanten hebben precies één commissie-sale, en geen
enkele betaalde factuur van een commissieklant hoort bij een andere echte deal
of bij een onbekend abonnement.

## Te beslissen: onduidelijke abonnementen bij commissieklanten (15)

Geen van deze heeft een betaalde factuur; ze bepalen pas toekomstige commissie.
Beslissen bij de klant: Abonnementen → knop ◇ (Soort abonnement).

| Klant | Abonnement | Start | Status | Waarom onduidelijk |
|---|---|---|---|---|
| Dominik Rowgalo | Aanbetaling · Maandelijkse termijnen | 15-08 / 15-09-2026 | geannuleerd | offerte (c6552f8a) getekend maar **gearchiveerd** |
| Laye Conde | Aanbetaling · Maandelijkse termijnen | 29-08-2026 | geannuleerd | offerte (35d28e1e) getekend maar **gearchiveerd** |
| Ibrahim Dorman | (zonder omschrijving) | 29-08-2026 | geannuleerd | geen getekende sale (commissie-sale ffa8eb75) |
| Gregory De Rubbel | Mentorship 1-op-1 6 m (1 termijn) | 12-08-2027 | geannuleerd | start 15 maanden na tekenen |
| Ibraguim Khamerzaev | Mentorship 1-op-1 12 m (18 termijnen) | 01-09-2026 | actief | start 4 maanden na tekenen (9 mei): uitstel? |
| Jaroslav Balog | 1-op-1 begeleiding 12 m (18 termijnen) | 01-12-2026 | actief | start 5 maanden na tekenen (1 jul): uitstel? |
| Richiano Blondiau | aanbetaling + 9 termijnen + 1 termijn | 01-09-2026 → 01-07-2027 | actief / geannuleerd | start > 92 d na tekenen (20 mei) |
| Tom Op t'Eynde | 4 abonnementen | 01-10-2026 → 01-09-2028 | actief / geannuleerd | start > 92 d na tekenen (17 jun) |

Waarschijnlijk zijn Ibraguim, Jaroslav, Richiano en Tom **aanpassing · uitstel**
van hun ene sale. Dat is een voorstel en geen keuze: het systeem zet het niet zelf.
