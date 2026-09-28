// api/_lib/iris/ordening.js
//
// Wat er eerst moet, in plaats van wat het laatst binnenkwam.
//
// ── WAAROM DIT GEEN PAGINERING-PROBLEEM IS ───────────────────────────────────
// De lijst laadde vijftig per keer en bladeren deed je met `vanaf`. Bij 318
// items zijn dat zeven keer klikken om te weten of er onderaan nog iets ligt --
// en niemand doet dat zeven keer.
//
// Doorlopend laden lost het klikken op, maar niet het probleem. Wat onderaan
// ligt zou je niet moeten hoeven zoeken: als het belangrijk is, hoort het
// bovenaan. Sorteren op "wat het laatst binnenkwam" zet juist het gesprek dat
// al drie dagen wacht onderaan.
//
// ── DE TWEE GROEPEN ──────────────────────────────────────────────────────────
// Sorteren op "dringendheid" als één getal kan niet in PostgREST: dat zou een
// berekende uitdrukking in ORDER BY zijn, en die verschuift bovendien elke
// minuut. Daarom twee groepen achter elkaar in plaats van één som:
//
//   1. DE KLOK. WhatsApp-gesprekken waarvan het venster van 24 uur bijna
//      dichtgaat, met de kortste tijd eerst. Dit is het enige in de lijst met
//      een deadline van buiten: over een uur kan het niet meer.
//   2. DE REST, nieuwste eerst. Zoals het altijd al was.
//
// Groep 1 is klein -- het is een venster van twee uur -- dus die past in zijn
// geheel bovenaan en hoeft niet mee in het bladeren. Dat is precies waarom het
// werkt: een groep die op elke pagina opnieuw zou verschijnen, zou de telling
// aan flarden schieten.
//
// Dit bestand importeert niets.

/** De twee ordeningen die de lijst kent. */
export const ORDENINGEN = Object.freeze(['dringend', 'nieuwste']);

/** Hoeveel gesprekken er hoogstens in de klok-groep passen. */
export const MAX_DRINGEND = 25;

/** Filters waar 'dringend' iets toevoegt. Elders is het nieuwste-eerst. */
export const DRINGEND_BIJ = Object.freeze(['wacht_op_ons', 'alles']);

/**
 * Welke ordening geldt er?
 *
 * Fail-zacht naar 'nieuwste': dat is wat de lijst altijd deed, dus een
 * onbekende waarde verandert niets in plaats van iets onverwachts te doen.
 */
export function leesOrdening(ruw, filter) {
  const gevraagd = String(ruw || '').trim();
  const o = ORDENINGEN.includes(gevraagd) ? gevraagd : 'dringend';
  if (o === 'dringend' && !DRINGEND_BIJ.includes(String(filter || ''))) return 'nieuwste';
  return o;
}

/**
 * Het tijdvenster waarin een WhatsApp-gesprek "bijna dicht" is.
 *
 * Tussen `van` en `tot` staat het venster nog open maar niet lang meer. Buiten
 * `tot` is er alle tijd, vóór `van` is het al dicht.
 *
 * @returns {{van: string, tot: string}} ISO-tijdstempels voor laatste_inbound
 */
export function klokVenster(nu = new Date(), vensterMs = 24 * 3600 * 1000, margeMin = 120) {
  const dicht = new Date(nu.getTime() - vensterMs);
  return {
    van: dicht.toISOString(),
    tot: new Date(dicht.getTime() + margeMin * 60 * 1000).toISOString(),
  };
}

/**
 * Plak de twee groepen aan elkaar, zonder dubbels.
 *
 * De klok-groep staat alleen bovenaan de EERSTE pagina. Hem op elke pagina
 * herhalen zou betekenen dat je bij het doorladen dezelfde gesprekken opnieuw
 * ziet -- en dan vertrouw je de lijst niet meer.
 *
 * @returns {{items: Array, dringend_aantal: number}}
 */
export function voegSamen(dringend, rest, { eerstePagina = true } = {}) {
  const kop = eerstePagina && Array.isArray(dringend) ? dringend.slice(0, MAX_DRINGEND) : [];
  const gezien = new Set(kop.map((r) => r?.id).filter(Boolean));
  const staart = (Array.isArray(rest) ? rest : []).filter((r) => r?.id && !gezien.has(r.id));
  return { items: [...kop, ...staart], dringend_aantal: kop.length };
}
