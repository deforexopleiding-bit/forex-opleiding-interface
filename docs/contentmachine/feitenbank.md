# Feitenbank (Contentmachine 2.0)

De ENIGE bron voor cijfers in de Weekeditie, de nieuwsbrief en de social-beelden, naast
de invoer van die week (wat Maxim invult, trade-gegevens, wat op een beeld staat).
Niets verzinnen, niets afronden tot iets mooiers, altijd de nuance mee. Sliders en
calculators tonen rekenvoorbeelden, geen beloftes.

De generator leest de kopie in `api/_lib/feitenbank.js` (docs/ en *.md gaan niet mee in de
deploy); `tests/contentmachine-weekeditie.test.js` houdt beide gelijk.

<!-- FEITEN-START -->
## Journal van het DFO-platform (salesdeck "20.244 trades", opgehaald op 8 oktober 2026)
- 20.244 trades gelogd door 177 studenten in het journal van het platform, over de voorbije twee jaar. Door studenten zelf gelogd, geen brokerafschriften; demo-, challenge- en funded accounts kunnen erbij zitten.
- Backtest-winrate 79% (78,7%) over 5.947 backtesttrades, zonder geld en zonder druk. Gemiddelde winnende trade in de backtest: 4,94R.
- Journal-winrate 48,5% over 6.881 journaltrades, met echt geld, druk en emotie. Gemiddelde winnende trade in het journal: 3,17R.
- Weten is niet hetzelfde als doen: van 79% in de backtest naar 48,5% in het echt.
- Bij een gemiddelde winnende trade van 3,17R ben je quitte vanaf 24% winrate. Over 100 trades bij 48,5% × 3,17R is dat +102R (rekenvoorbeeld, break-evens = 0R).
- De mediaanstudent (mediaan van de 47 studenten met minstens 30 journaltrades): +70,5% over 19 maanden bij 1% risico per trade, zonder samengestelde groei; dat is 4,15% per maand. Op een 100K-account is dat +$70.540 vóór de profit split.
- 41 van de 47 studenten met minstens 30 journaltrades staan in totaal in winst.
- Uitsplitsing journaltrades (winrate): sessie Londen 50,7% (1.716 trades), Azië 50,6% (807), New York 45,6% (1.564); long 53,8% (3.260), short 43,3% (3.471); continuation 51,7%, reversal 40,4%; maandag 53,1% (1.258), dinsdag 45,3% (1.240); beste paren CHFJPY 57,5% (215), EURCHF 55,0% (235), XAUUSD 54,4% (126), AUDCHF 53,4% (312), EURUSD 52,6% (687). Gemiddelde = 48,5%.

## Methode en risico
- DFO-fibonacci: niveaus 1, 0, 71 en −27. Entry op 71, stop onder/boven 1, risk free op 0, target op −27: ongeveer 3,4R per trade.
- Risico: 1% per trade-idee (mag 0,5% op het fib-niveau + 0,5% op de OB).
- Masterclass deel 1: met 1 op 3 ben je al winstgevend met 30% winrate (30 × 3R − 70 × 1R = +20R over 100 trades).

## Payouts (bibliotheek, met toestemming; bedrag zoals op het bewijs)
- Karl — Alpha Capital, performance fee $24.580 (21 apr 2026).
- Shani — FTMO, $25.016.
- Maxim — Traders Global, $28.983.
- Maxim — FTMO, $1.831 · $2.806 · $4.698 · $7.598.
- Leslie — FTMO, $4.536 · $6.721 · $7.381.
- Luc — FTMO (gedeeld in Discord). Maxim — FundedNext (payouts 2024).
- In de masterclass: "€138.695 aan uitbetalingen — van vijf mensen" (echte uitbetalingen van eigen accounts en studenten, bedragen in € en $ samengeteld; GEEN totaal van alle studenten).

## Altijd erbij
- Resultaten uit het verleden zijn geen garantie voor de toekomst. Traden houdt risico op verlies in.
- Een funded account is kapitaal van een prop firm; voorwaarden, kosten en splits verschillen per firma.
<!-- FEITEN-EINDE -->
