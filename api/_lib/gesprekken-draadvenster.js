// api/_lib/gesprekken-draadvenster.js
//
// Hoeveel van een gesprek je in één keer ophaalt, en hoe je aan de rest komt.
//
// ── HET GAT ──────────────────────────────────────────────────────────────────
// inbox-thread-unified haalde ÁLLE WhatsApp-berichten van een gesprek op, plus
// alle mail van de klant, voegde die samen, en gooide daarna alles weg behalve
// de laatste 200. Twee dingen zijn daar mis mee, en ze zijn allebei stil:
//
//   1. Het werk groeit mee met de geschiedenis. Een gesprek van duizend
//      berichten haalt duizend rijen op om er achthonderd weg te gooien. Dat
//      werkt tot het niet meer werkt, en dan is het een tijdslimiet op een
//      gesprek met precies die klant met wie je het meest gepraat hebt.
//   2. Wat je niet krijgt, zie je niet. Het endpoint meldde al hoeveel er
//      waren (`counts.total`) tegenover hoeveel het teruggaf (`counts.returned`),
//      maar het scherm deed daar niets mee. Je leest een gesprek dat halverwege
//      begint zonder dat iets dat zegt. Gat G8 uit de audit.
//
// ── WAAROM NIEUWSTE-EERST OPHALEN EN DAN OMDRAAIEN ───────────────────────────
// Een gesprek lees je van onder naar boven: het laatste bericht is waar het om
// gaat. Dus vragen we per bron de NIEUWSTE n+1 en draaien we om, in plaats van
// alles op te halen en de staart te houden. De n+1'e rij is er alleen om te
// weten dát er meer is — hij wordt niet getoond.
//
// Per bron n+1 halen en dan samenvoegen geeft gegarandeerd de juiste nieuwste
// n: elke bron levert er minstens zoveel als hij aan de top zou kunnen leveren.
//
// ── DE GRENS: KLEINER-OF-GELIJK, NIET KLEINER ────────────────────────────────
// De volgende bladzijde vraagt om wat er vóór het oudste getoonde bericht zit.
// Met "kleiner dan" verdwijnt alles dat op exact dezelfde tijdstempel staat als
// de grens — en bij mail is die tijdstempel op de seconde nauwkeurig, dus twee
// berichten in dezelfde seconde is geen bedenksel. Daarom "kleiner of gelijk",
// en gooit de aanroeper de dubbelen eruit op id. Dat kost één vergelijking en
// het kost je nooit een bericht.

/** De standaard- en maximumomvang van één bladzijde. Spiegelt clampInt in het endpoint. */
export const VENSTER_STANDAARD = 200;
export const VENSTER_MAX = 500;

/**
 * Lees de grens uit de vraag.
 *
 * Streng, want een grens die niet klopt mag NOOIT stilletjes "dan maar alles"
 * betekenen: dat is precies de opvraging zonder filter die we elders ook
 * weren. Onleesbaar in, null eruit, en de aanroeper haalt gewoon de nieuwste
 * bladzijde op.
 */
export function leesGrens(waarde) {
  if (waarde === null || waarde === undefined) return null;
  const s = String(waarde).trim();
  if (!s) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

/**
 * Hoeveel rijen we per bron ophalen.
 *
 * Eén meer dan we tonen. Die ene extra is het antwoord op "is er nog meer?",
 * zonder een tweede opvraging die alleen maar telt.
 */
export function ophaalAantal(limit) {
  const n = Number(limit);
  const veilig = Number.isFinite(n) ? Math.trunc(n) : VENSTER_STANDAARD;
  return Math.min(Math.max(veilig, 1), VENSTER_MAX) + 1;
}

/**
 * Knip de samengevoegde lijst tot één bladzijde.
 *
 * @param {Array<{id?: string, at?: string}>} items  oplopend gesorteerd (oudste eerst)
 * @param {number} limit
 * @returns {{zichtbaar: Array, heeftMeer: boolean, oudsteAt: string|null}}
 */
export function venster(items, limit) {
  const lijst = Array.isArray(items) ? items : [];
  const n = Number(limit);
  const max = Number.isFinite(n) && n > 0 ? Math.trunc(n) : VENSTER_STANDAARD;

  const heeftMeer = lijst.length > max;
  const zichtbaar = heeftMeer ? lijst.slice(lijst.length - max) : lijst;
  const oudsteAt = zichtbaar.length ? (zichtbaar[0].at || null) : null;

  return { zichtbaar, heeftMeer, oudsteAt };
}

// Het ontdubbelen van de bladzijdegrens gebeurt aan de KANT VAN HET SCHERM,
// want dat is de plek die twee bladzijden naast elkaar heeft liggen. Zie
// draadSleutel() en nieuweDraadItems() in modules/shared/gesprekken-v2.js.
// Hier staat het bewust niet ook nog een keer.
