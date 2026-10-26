// api/_lib/feitenbank.js
//
// KOPIE van docs/contentmachine/feitenbank.md (tussen FEITEN-START en FEITEN-EINDE):
// docs/ en *.md gaan niet mee in de deploy. tests/contentmachine-weekeditie.test.js
// houdt beide gelijk. Plus controleerCijfers(): elk cijfer in een data-blok, een groot
// getal, een payout-bedrag of een slider-voorinstelling moet in de feitenbank, de
// invoer van de week of op een beeld staan.

export const FEITENBANK = "## Journal van het DFO-platform (salesdeck \"20.244 trades\", opgehaald op 8 oktober 2026)\n- 20.244 trades gelogd door 177 studenten in het journal van het platform, over de voorbije twee jaar. Door studenten zelf gelogd, geen brokerafschriften; demo-, challenge- en funded accounts kunnen erbij zitten.\n- Backtest-winrate 79% (78,7%) over 5.947 backtesttrades, zonder geld en zonder druk. Gemiddelde winnende trade in de backtest: 4,94R.\n- Journal-winrate 48,5% over 6.881 journaltrades, met echt geld, druk en emotie. Gemiddelde winnende trade in het journal: 3,17R.\n- Weten is niet hetzelfde als doen: van 79% in de backtest naar 48,5% in het echt.\n- Bij een gemiddelde winnende trade van 3,17R ben je quitte vanaf 24% winrate. Over 100 trades bij 48,5% × 3,17R is dat +102R (rekenvoorbeeld, break-evens = 0R).\n- De mediaanstudent (mediaan van de 47 studenten met minstens 30 journaltrades): +70,5% over 19 maanden bij 1% risico per trade, zonder samengestelde groei; dat is 4,15% per maand. Op een 100K-account is dat +$70.540 vóór de profit split.\n- 41 van de 47 studenten met minstens 30 journaltrades staan in totaal in winst.\n- Uitsplitsing journaltrades (winrate): sessie Londen 50,7% (1.716 trades), Azië 50,6% (807), New York 45,6% (1.564); long 53,8% (3.260), short 43,3% (3.471); continuation 51,7%, reversal 40,4%; maandag 53,1% (1.258), dinsdag 45,3% (1.240); beste paren CHFJPY 57,5% (215), EURCHF 55,0% (235), XAUUSD 54,4% (126), AUDCHF 53,4% (312), EURUSD 52,6% (687). Gemiddelde = 48,5%.\n\n## Methode en risico\n- DFO-fibonacci: niveaus 1, 0, 71 en −27. Entry op 71, stop onder/boven 1, risk free op 0, target op −27: ongeveer 3,4R per trade.\n- Risico: 1% per trade-idee (mag 0,5% op het fib-niveau + 0,5% op de OB).\n- Masterclass deel 1: met 1 op 3 ben je al winstgevend met 30% winrate (30 × 3R − 70 × 1R = +20R over 100 trades).\n\n## Payouts (bibliotheek, met toestemming; bedrag zoals op het bewijs)\n- Karl — Alpha Capital, performance fee $24.580 (21 apr 2026).\n- Shani — FTMO, $25.016.\n- Maxim — Traders Global, $28.983.\n- Maxim — FTMO, $1.831 · $2.806 · $4.698 · $7.598.\n- Leslie — FTMO, $4.536 · $6.721 · $7.381.\n- Luc — FTMO (gedeeld in Discord). Maxim — FundedNext (payouts 2024).\n- In de masterclass: \"€138.695 aan uitbetalingen — van vijf mensen\" (echte uitbetalingen van eigen accounts en studenten, bedragen in € en $ samengeteld; GEEN totaal van alle studenten).\n\n## Altijd erbij\n- Resultaten uit het verleden zijn geen garantie voor de toekomst. Traden houdt risico op verlies in.\n- Een funded account is kapitaal van een prop firm; voorwaarden, kosten en splits verschillen per firma.";

/** Alle getallen in een tekst (Nederlandse notatie: 20.244 / 48,5 / −27 / $24.580). */
export function getallenIn(tekst) {
  const uit = new Set();
  for (const m of String(tekst || '').matchAll(/\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?/g)) {
    const ruw = m[0];
    // "20.244" = twintigduizend (duizendtalpunt); "48,5" en "4.15" = decimaal.
    const duizend = /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(ruw);
    const n = duizend ? Number(ruw.replace(/\./g, '').replace(',', '.')) : Number(ruw.replace(',', '.'));
    if (Number.isFinite(n)) uit.add(n);
    if (duizend && !ruw.includes(',')) { const d = Number(ruw); if (Number.isFinite(d)) uit.add(d); }
  }
  return uit;
}

const BASIS = getallenIn(FEITENBANK);

/** Toets: komt een cijfer uit de feitenbank of de bronnen? */
export function cijferToets(bronnen = []) {
  const toegestaan = new Set(BASIS);
  for (const t of bronnen) for (const n of getallenIn(t)) toegestaan.add(n);
  return (v) => typeof v === 'number' && [...toegestaan].some((t) => Math.abs(t - v) < 1e-9);
}

/**
 * Cijfers die nergens vandaan komen. `extra` = losse [{ pad, waarde }] (bv. de data-beelden
 * van de social). `bronnen` = extra teksten (invoer van de week,
 * bijschriften en AI-details van de beelden). → [{ pad, waarde }]
 */
export function controleerCijfers(pagina, bronnen = [], extra = []) {
  const ok = cijferToets(bronnen);
  const uit = extra.filter((x) => !ok(x.waarde));
  ((pagina && pagina.blokken) || []).forEach((b, i) => {
    const p = (b && b.props) || {};
    if (b.type === 'hero' && p.getal && !ok(p.getal.waarde)) uit.push({ pad: `blokken[${i}].props.getal`, waarde: p.getal.waarde });
    if (b.type === 'data') (p.cijfers || []).forEach((c, j) => { if (c && !ok(c.waarde)) uit.push({ pad: `blokken[${i}].props.cijfers[${j}]`, waarde: c.waarde }); });
    if (b.type === 'payout-muur') (p.payouts || []).forEach((x, j) => { if (x && !ok(x.bedrag)) uit.push({ pad: `blokken[${i}].props.payouts[${j}].bedrag`, waarde: x.bedrag }); });
    if (b.type === 'rr-sliders') (p.voorinstellingen || []).forEach((x, j) => { if (x && (!ok(x.winrate) || !ok(x.rr))) uit.push({ pad: `blokken[${i}].props.voorinstellingen[${j}]`, waarde: `${x.winrate}% × ${x.rr}R` }); });
    if (b.type === 'funded-calculator' && p.referentie && !ok(p.referentie.rendement)) uit.push({ pad: `blokken[${i}].props.referentie`, waarde: p.referentie.rendement });
    if (b.type === 'trade-ontleed' && typeof p.resultaat_r === 'number' && !ok(p.resultaat_r)) uit.push({ pad: `blokken[${i}].props.resultaat_r`, waarde: p.resultaat_r });
  });
  return uit;
}
