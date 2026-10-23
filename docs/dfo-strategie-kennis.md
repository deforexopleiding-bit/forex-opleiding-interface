# DFO-strategiekennis (systeemkennis voor de Contentmachine)

Bron: bouwopdracht Contentmachine, bijlage A (23 okt 2026). Tips en uitleg in de
gegenereerde content mogen ENKEL hieruit komen. Onbekend = niet verzinnen.
De generator leest de kopie in `api/_lib/dfo-strategie-kennis.js` (docs/ en *.md gaan
niet mee in de deploy); `tests/contentmachine-generator.test.js` houdt beide gelijk.

<!-- KENNIS-START -->
- Kern: we voorspellen niet blind waar prijs draait. De hogere timeframe (H4) geeft richting en locatie; daarna wachten we tot liquidity en orderflow op de lagere timeframe (15M) bevestigen dat de markt opnieuw in onze richting wil.
- Daytrade-volgorde: H4 context → geldige impuls → H4 fibonacci/range → retracement → 15M context → liquidity → structure shift met volume → 15M fibonacci → entry → target. Een 15M-setup zonder geldige H4-context is geen DFO-trade.
- Geldige impuls: uit geldige structuur, structurele beweging, displacement/body close, en volume (= agressieve verplaatsing zichtbaar als FVG of Hidden FVG; niet de volume-indicator). Een wick-break is geen bevestigde impuls.
- Fibonacci-levels: 1, 0, 71% en -27. Het 71%-niveau is het centrale referentiepunt. H4 71% geraakt = enkel locatie, geen entry.
- Entry op de 71%-zone van de nieuwe 15M-impuls; stop waar de setup structureel ongeldig wordt (onder het 1-level); risk free bij het 0-level; target op -27 (≈ 3,4R).
- Swing/H4-limit: als op H4 alles aanwezig is, limit op H4 71, stop onder H4 1, risk free bij H4 0, target H4 -27. (Niet "swing" noemen naar buiten.)
- Order Block, FVG, Hidden FVG, liquidity en inducement zijn confluence binnen een geldige setup, nooit op zichzelf een reden om te traden.
- BOS = body close door vorige high/low. Sweep vs BOS onderscheiden via volume. Wick-only = geen BOS.
- Risk: 1% per trade-idee (mag 0,5% op het fib-niveau + 0,5% op de OB). Eerst bepalen waar de trade ongeldig is, dan pas positieomvang.
- Harde regels: geen nieuwe positie 1 uur vóór FOMC, CPI of NFP; geen nieuwe trades na 21:00; rollover 23:00–00:30 (spreads); daytrades vóór het weekend sluiten.
- Verboden simplificaties: "prijs raakt 71% dus we nemen een trade", "liquidity sweep dus we kopen", "er staat een OB dus setup", "een FVG komt sowieso terug", "structure break = automatisch entry".
- Drie bouwstenen van een trader: strategie, risk management, psychologie & uitvoering (discipline, geduld, routine, journaling, reflectie, data).
- Bij twijfel of ontbrekende regel: niet invullen met algemene ICT/SMC-regels.
<!-- KENNIS-EINDE -->
