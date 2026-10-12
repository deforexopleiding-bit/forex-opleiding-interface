// api/_lib/iris/aandacht.js
//
// Wat er NÚ moet gebeuren, in één regel.
//
// ── DE REGEL ACHTER DE REGEL ─────────────────────────────────────────────────
// Eén ding schreeuwt, en alleen als het schreeuwen waard is. Een balk die er
// altijd staat, lees je na twee dagen niet meer — dan is hij erger dan geen
// balk, want hij neemt de plek in van iets dat wél nieuw is.
//
// Daarom: is er niets, dan is er ook geen regel. En staan er meerdere dingen
// te wachten, dan wint het dringendste; de rest staat er achteraan als getal
// en niet als tweede alarm.
//
// ── DE VOLGORDE IS DE VOLGORDE VAN ONOMKEERBAARHEID ──────────────────────────
//   1. Een venster dat bijna dichtgaat. Over een uur kan het niet meer, en dan
//      kan het de eerstvolgende 24 uur alleen nog met een template. Dat is het
//      enige hier met een harde klok van buiten.
//   2. Een melding die hangt. Iemand vroeg om bericht, de termijn is om, en de
//      mail kwam niet aan. Stil kapot is het ergste soort kapot.
//   3. Werk dat wacht. Belangrijk, maar het loopt niet weg.
//
// Dit bestand importeert niets, zodat de volgorde na te rekenen is zonder
// databank.

/** Wat er geteld wordt, in de volgorde waarin het voorrang krijgt. */
export const SOORTEN = Object.freeze(['venster_bijna_dicht', 'melding_hangt', 'wacht_op_ons']);

/**
 * De ene regel, of niets.
 *
 * @param {{venster_bijna_dicht?: number, melding_hangt?: number, wacht_op_ons?: number}} tellingen
 * @returns {null | {soort: string, tekst: string, toon: 'dringend'|'let_op', naar: object}}
 */
export function aandachtsregel(tellingen = {}) {
  const t = (k) => Math.max(0, Number(tellingen?.[k]) || 0);

  const venster = t('venster_bijna_dicht');
  if (venster > 0) {
    return {
      soort: 'venster_bijna_dicht',
      toon: 'dringend',
      tekst: venster === 1
        ? 'Bij één gesprek loopt het venster van 24 uur bijna af.'
        : `Bij ${venster} gesprekken loopt het venster van 24 uur bijna af.`,
      naar: { tab: 'post', filter: 'venster_bijna_dicht' },
    };
  }

  const hangt = t('melding_hangt');
  if (hangt > 0) {
    return {
      soort: 'melding_hangt',
      toon: 'dringend',
      tekst: hangt === 1
        ? 'Eén opvolging is verlopen en de melding is niet aangekomen.'
        : `${hangt} opvolgingen zijn verlopen en die meldingen zijn niet aangekomen.`,
      naar: { tab: 'opdrachten' },
    };
  }

  // Werk dat wacht is geen alarm. Pas boven een drempel is het een mededeling
  // waard -- anders staat er elke ochtend een regel die zegt dat er werk is,
  // en dat wist je al.
  const wacht = t('wacht_op_ons');
  if (wacht >= DREMPEL_WACHT) {
    return {
      soort: 'wacht_op_ons',
      toon: 'let_op',
      tekst: `${wacht} gesprekken wachten op een antwoord.`,
      naar: { tab: 'post', filter: 'wacht_op_ons' },
    };
  }

  return null;
}

/**
 * Vanaf hoeveel wachtende gesprekken het het noemen waard is.
 *
 * Niet nul: dan staat de regel er altijd. Niet honderd: dan staat hij er nooit.
 * Twintig is ruwweg "meer dan een ochtend werk" bij de aantallen die gemeten
 * zijn (finance 211 gesprekken, waarvan 203 open).
 */
export const DREMPEL_WACHT = 20;

/**
 * Het getal boven een lijst.
 *
 * "Hoe groot is dit, en wat ervan dringt" — het droogtest-patroon uit
 * Instellingen, dat als enige in Iris een antwoord gaf in plaats van een lijst
 * om doorheen te gaan.
 */
export function lijstTelling(totaal, dringend = 0) {
  const n = Math.max(0, Number(totaal) || 0);
  const d = Math.max(0, Number(dringend) || 0);
  if (!n) return null;
  const woord = n === 1 ? '1 gesprek' : `${n} gesprekken`;
  return d > 0 ? `${woord} · ${d} dringt` : woord;
}
