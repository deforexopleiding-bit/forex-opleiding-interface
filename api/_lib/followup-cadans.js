// api/_lib/followup-cadans.js
//
// Eén plek voor de vraag "hoe vaak bellen we, met welke tussenpozen, en wat
// gebeurt er als het op is". Per HERKOMST van de rij, niet per status.
//
// WAAROM DIT BESTAAT
// De getallen stonden als losse constanten in follow-up-lead-outcome.js
// (CADENCE_HOURS / MAX_ATTEMPTS). Zolang er één cadans was ging dat goed.
// Nu er twee zijn — gratis event-leads krijgen minder pogingen dan
// betalende klanten — zou dat getal op meerdere plekken belanden en over
// een half jaar op elke plek iets anders zeggen. Daarom: hier, als data.
//
// HET ONDERSCHEID IS DE HERKOMST, NIET DE STATUS
//   'event'      — gratis leads uit een event: no-shows, afgemelden, en
//                  wie na afloop nog moest beslissen. VIJF pogingen. Bij de
//                  vijfde vergeefse poging gaat de rij DICHT met reden
//                  'onbereikbaar' (zie `bijMax`).
//
//                  Waarom vijf en waarom dicht: de regel is "nooit stil
//                  kwijtraken, wel bewust afsluiten". Iemand die blijft
//                  negeren hoeft niet eeuwig in beeld te blijven, en wie
//                  zich gestalkt voelt hoeft niet gebeld te worden. Vijf is
//                  waar die twee elkaar raken. Het afsluiten is een keuze
//                  die zichtbaar in het uitkomstenlog staat, geen lek.
//   'retention'  — betalende klanten die verlengd moeten worden. Sinds
//                  27-08-2026 ook VIJF pogingen, gelijk aan event. Niet omdat
//                  het inhoudelijk hetzelfde is, maar omdat één getal
//                  uitlegbaar is aan een salesteam en twee getallen tot
//                  "hoeveel was het ook alweer" leiden.
//                  Al het andere aan deze cadans blijft ongewijzigd: bij de
//                  laatste poging krijgt de rij status 'niet_bereikbaar' en
//                  BLIJFT hij open, en er wordt geen taak aangemaakt. Een
//                  betalende klant is een ander soort lead dan een gratis
//                  event-inschrijving; alleen het aantal is gelijkgetrokken.
//   al het rest  — valt terug op CADANS_STANDAARD. Die staat bewust nog op
//                  vier: dat is exact wat er vóór dit bestand gebeurde, en
//                  een herkomst die hier niet genoemd wordt hoort niet
//                  stilletjes mee te veranderen met een besluit dat over
//                  event en retentie ging.
//
// LET OP — de belronde vóór een event valt hier BUITEN.
// Die leads hebben óók source='event', maar volgen een eigen ritme (vandaag
// 18:00, anders morgen 12:00, en stoppen zodra er geen slot meer is vóór de
// eventdatum). Dat pad is te herkennen aan `source_ref.event_date` en wordt
// door follow-up-lead-outcome.js apart afgehandeld. Het is bewust ongemoeid
// gelaten.

// DE WHATSAPP-TAAK
// Bij een event-lead is er ná de tweede vergeefse belpoging nog precies één
// poging over. Dat is het moment om een ander kanaal te proberen in plaats
// van nog een keer te bellen. `taakBijPoging` zegt bij welke poging er een
// taak in Takenbeheer klaargezet wordt; null = nooit. Ook dit hoort bij de
// herkomst en niet in een if midden in de belmotor.

/** Wat er gebeurt zodra het maximum bereikt is. */
export const BIJ_MAX = Object.freeze({
  /** Rij dicht: lead_status 'verloren', reden in het notitielog. */
  AFSLUITEN: 'afsluiten',
  /** Rij blijft open met status 'niet_bereikbaar' — het huidige gedrag. */
  MARKEREN : 'markeren',
});

/**
 * Tussenpozen ná poging 1, 2, 3 … in uren. Is het aantal pogingen groter
 * dan deze lijst, dan geldt de laatste waarde. Voor beide herkomsten
 * gelijk gehouden — alleen het máximum verschilt, en dat was de beslissing.
 */
const UREN_STANDAARD = Object.freeze([2, 24, 72]);

export const CADANS_STANDAARD = Object.freeze({
  maxPogingen       : 4,
  urenTussenPogingen: UREN_STANDAARD,
  bijMax            : BIJ_MAX.MARKEREN,
  taakBijPoging     : null,
  taakPrioriteit    : 'Normaal',
});

export const CADANS = Object.freeze({
  event: Object.freeze({
    maxPogingen       : 5,
    urenTussenPogingen: UREN_STANDAARD,
    bijMax            : BIJ_MAX.AFSLUITEN,
    // Na de tweede vergeefse poging: WhatsApp proberen. Dat is juist de
    // ontsnapping die maakt dat je iemand niet vijf keer hóéft te bellen —
    // vandaar vroeg in de reeks en niet vlak voor het einde.
    taakBijPoging     : 2,
    taakPrioriteit    : 'Normaal',
  }),
  retention: Object.freeze({
    maxPogingen       : 5,
    urenTussenPogingen: UREN_STANDAARD,
    bijMax            : BIJ_MAX.MARKEREN,
    // Retentie houdt exact het huidige gedrag: geen automatische taak.
    taakBijPoging     : null,
    taakPrioriteit    : 'Normaal',
  }),
});

/**
 * De cadans voor een herkomst. Onbekend of leeg → CADANS_STANDAARD.
 * @param {string|null|undefined} herkomst  de waarde van follow_up_leads.source
 */
export function cadansVoor(herkomst) {
  const sleutel = String(herkomst || '').trim();
  return Object.prototype.hasOwnProperty.call(CADANS, sleutel)
    ? CADANS[sleutel]
    : CADANS_STANDAARD;
}

/**
 * Hoeveel uur tot de volgende poging, gegeven het nummer van de poging die
 * zojuist mislukte (1-gebaseerd). Voorbij de lijst geldt de laatste waarde.
 */
export function urenTotVolgendePoging(herkomst, pogingNr) {
  const uren = cadansVoor(herkomst).urenTussenPogingen;
  const idx = Math.max(0, Math.min(uren.length - 1, Number(pogingNr || 1) - 1));
  return uren[idx];
}
