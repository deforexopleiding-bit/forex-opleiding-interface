// api/_lib/opvolging-call-afgerond.js
//
// DE AFRONDKNOP MOET TONEN DAT HIJ AL GEBRUIKT IS.
//
// Maxims reden, en die bepaalt het ontwerp: Dave rondt er 's ochtends twee af,
// kijkt 's middags opnieuw, en moet dan kunnen zien welke twee. Anders doet hij
// het dubbel — dezelfde call krijgt twee uitkomsten en de tweede overschrijft
// de eerste.
//
// Dus: zodra er voor een afspraak een uitkomst is vastgelegd via die knop,
// toont de kaart dat — 'afgerond', met de uitkomst erbij — in plaats van
// opnieuw een knop.
//
// ── WAAROM `uitkomst` EN NIET `status` ───────────────────────────────────
// Dit is het beslissende onderscheid, en api/follow-up-appointment-outcome.js
// legt het zelf uit: `status` beantwoordt 'hoe staat deze afspraak er nu voor',
// `uitkomst` beantwoordt 'wat is er besloten'. Sale en gesprek_gehad worden
// allebei `completed`; wilt_niet_meer en niet_geschikt allebei `cancelled`.
// Uit de status is dus niet af te lezen of er verkocht is — en al helemaal niet
// of DAVE iets heeft vastgelegd.
//
// `uitkomst` wordt uitsluitend geschreven door writeUitkomst() in dat endpoint,
// en dat is precies de weg die de afrondknop neemt. De vraag 'heeft Dave deze
// al gedaan?' is daarmee exact de vraag 'staat er een uitkomst'.
//
// Bijkomend, en het is geen toeval: een undo maakt `uitkomst` weer leeg. Een
// vergissing herstelt zichzelf dus naar een knop, zonder dat daar iets extra's
// voor gebouwd hoeft te worden.
//
// De module blijft hiermee op zichzelf werken: dit leest niets uit GHL en toont
// geen enkele externe status. Alleen wat er in onze eigen module is vastgelegd.

/** De uitkomsten die het afrond-endpoint kent, in Daves taal. */
const LABEL = {
  sale          : 'klant geworden',
  gesprek_gehad : 'gesprek gehad',
  wilt_niet_meer: 'geen interesse',
  niet_geschikt : 'niet geschikt',
  no_show       : 'niet gekomen',
  later_opnieuw : 'later opnieuw',
  terugbel      : 'terugbellen',
  verzetten     : 'verzet',
  annuleren     : 'geannuleerd',
};

/**
 * Is deze afspraak in onze module afgerond, en waarmee?
 *
 * @returns {{code:string,label:string,op:?string}|null} null = nog niet
 *   afgerond, dus de knop hoort te blijven staan.
 */
export function afgerondAls(afspraak) {
  const u = afspraak && afspraak.uitkomst ? String(afspraak.uitkomst).trim().toLowerCase() : '';
  if (!u) return null;
  return {
    code : u,
    // Een onbekende uitkomst tonen we leesbaar in plaats van te verbergen: dat
    // er iets vastligt is het punt, en welke waarde precies is dan nog steeds
    // meer informatie dan een knop die doet alsof er niets is.
    label: LABEL[u] || u.replace(/_/g, ' '),
    op   : (afspraak && afspraak.uitkomst_op) || null,
  };
}

/**
 * Hoort er bij deze call nog een afrondknop, of de uitkomst?
 *
 * Pure functie zodat de regel in een test staat en niet alleen op het scherm.
 */
export function afrondActie(afspraak) {
  const vast = afgerondAls(afspraak);
  return vast ? { toon: 'uitkomst', vastgelegd: vast } : { toon: 'knop', vastgelegd: null };
}
