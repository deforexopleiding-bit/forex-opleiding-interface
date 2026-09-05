// services/whatsapp-brug/lib/uitkomst.js
//
// Het verschil tussen 'bestaat niet', 'gaf niets terug' en 'gaf iets terug dat
// we niet konden gebruiken'.
//
// Deze les kwam twee keer terug en kostte allebei de keren een ronde. Eerst gaf
// getCurrentLid 0 van 28 zonder fout — en pas de derde meting liet zien dat die
// functie in die context helemaal niet bestond. Onze code las 'bestaat niet' als
// 'geen resultaat', en dat is geen meting maar een stilte.
//
// Een controle die null teruggeeft, geeft dus twee verschillende antwoorden
// dezelfde vorm. Vandaar deze vier statussen. Ze kosten één regel per aanroep en
// besparen een avond raden.

export const BESTAAT_NIET  = 'bestaat_niet';    // de functie of het veld is er niet
export const GEEN_RESULTAAT = 'geen_resultaat'; // bestond wel, gaf niets terug
export const ONBRUIKBAAR   = 'onbruikbaar';     // gaf iets, maar niet wat we nodig hebben
export const GELUKT        = 'gelukt';
export const FOUT          = 'fout';            // wierp een uitzondering

export const STATUSSEN = [BESTAAT_NIET, GEEN_RESULTAAT, ONBRUIKBAAR, GELUKT, FOUT];

/**
 * Probeer iets, en zeg preciés wat eruit kwam.
 *
 *   bestaat  — is het ding er überhaupt? (een boolean die je zelf bepaalt)
 *   haal     — de functie die de waarde ophaalt
 *   bruikbaar— beslist of de waarde is wat we zochten
 *
 * `waarde` komt alleen terug bij GELUKT en blijft binnen de aanroeper; wat naar
 * /status gaat is uitsluitend de status en de cijferlengte.
 */
export async function probeer({ bestaat, haal, bruikbaar = (v) => !!v }) {
  if (!bestaat) return { status: BESTAAT_NIET, waarde: null, lengte: null };
  let waarde;
  try {
    waarde = await haal();
  } catch (_) {
    return { status: FOUT, waarde: null, lengte: null };
  }
  if (waarde === null || waarde === undefined || waarde === '') {
    return { status: GEEN_RESULTAAT, waarde: null, lengte: null };
  }
  const lengte = String(waarde).replace(/\D/g, '').length;
  if (!bruikbaar(waarde)) return { status: ONBRUIKBAAR, waarde: null, lengte };
  return { status: GELUKT, waarde, lengte };
}

/** Een lege telling per status, om er in /status mee op te tellen. */
export function leegPerStatus() {
  return Object.fromEntries(STATUSSEN.map((s) => [s, 0]));
}
