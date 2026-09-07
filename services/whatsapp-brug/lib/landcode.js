// services/whatsapp-brug/lib/landcode.js
//
// EEN LOKAAL GENOTEERD NUMMER BRUIKBAAR MAKEN, ZONDER TE RADEN.
//
// Van de 33 opvolgtaken staan er zes met een lokaal genoteerd nummer:
// 0472223752, 0472342612, 0483467656, 0476464399, 0494382885 en 06 57340618.
// Die passeren het leadlijst-filter nog wel — dat heeft een staart-ingang op de
// laatste negen cijfers — maar naarChatId() geeft null zodra een nummer met een
// 0 begint. Gevolg: getNumberId faalt bij het opbouwen van de lidkaart, én
// wa.stuur() gooit NUMMER_ONGELDIG. Dave kan bij bijna één op de vijf
// openstaande taken geen WhatsApp versturen: de knop staat er, het venster
// opent, en pas bij verzenden blijkt het niet te kunnen.
//
// WAAROM WE DE LANDCODE NIET RADEN. Vijf van die zes zijn Belgisch en één is
// Nederlands (06 57340618). Een vaste aanname 'dit is een Belgisch bedrijf, dus
// 32' zou dat ene nummer naar een wildvreemde in België sturen. Dat is precies
// de fout die naarChatId() destijds terecht wilde voorkomen.
//
// WAT WE IN PLAATS DAARVAN DOEN. We stellen de kandidaten op en laten WhatsApp
// beslissen: client.getNumberId() zegt of een nummer daar bestaat. Alleen als
// er PRECIES ÉÉN kandidaat bevestigd wordt, gebruiken we die. Twee treffers is
// gokken, en dat doen we niet bij een privacyfilter — dan gaat er niets uit.
//
// Dit bestand is puur: geen client, geen netwerk. De bevestiging komt als
// functie binnen, zodat de regel te testen is zonder puppeteer of telefoon.

import { normaliseerNummer } from './nummers.js';

/**
 * De landcodes die we proberen, in vaste volgorde.
 *
 * Twee, en niet meer: de leadlijst komt uit de eventmodule en die events staan
 * in België en Nederland. Een derde landcode erbij zetten 'voor de zekerheid'
 * vergroot alleen de kans op twee treffers, en twee treffers levert niets op.
 */
export const LANDCODES = ['32', '31'];

/**
 * De code waarmee `bevestig` mag zeggen: deze vraag is hier niet te stellen.
 *
 * Anders dan een gewone fout. 'de bibliotheek kan dit niet' en 'WhatsApp kent
 * dit nummer niet' zijn twee verschillende antwoorden, en die mogen niet
 * dezelfde vorm krijgen — dat is de les uit lib/uitkomst.js, en de hele
 * LID-zoektocht is erop stukgelopen.
 */
export const NIET_MEETBAAR = 'NIET_MEETBAAR';

/**
 * Welke uitkomsten kennis zijn, en dus onthouden mogen worden.
 *
 * 'mislukt' en 'niet_meetbaar' staan er bewust NIET in: die zeggen niets over
 * het nummer, alleen iets over het moment.
 */
export const ONTHOUDBAAR = new Set(['gevonden', 'meerdere', 'geen']);

/** Is dit nummer lokaal genoteerd? (begint met een 0 na het strippen) */
export function isLokaalGenoteerd(raw) {
  const c = normaliseerNummer(raw);
  return !!c && c.startsWith('0');
}

/**
 * De internationale kandidaten voor een lokaal genoteerd nummer.
 *
 * '0472223752' → ['32472223752', '31472223752']
 * '06 57340618' → ['32657340618', '31657340618']
 *
 * Een nummer dat al internationaal is levert een lege lijst op: daar valt niets
 * te kiezen, en de aanroeper hoort dat pad dan helemaal niet in te gaan.
 */
export function kandidatenVoor(raw) {
  const c = normaliseerNummer(raw);
  if (!c || !c.startsWith('0')) return [];
  // Eén voorloop-nul eraf. Meerdere nullen is geen notatie die we kennen, en er
  // net zolang nullen afhalen tot het past is opnieuw raden.
  const rest = c.replace(/^0/, '');
  if (rest.length < 8 || rest.startsWith('0')) return [];
  return LANDCODES.map((code) => code + rest);
}

/**
 * Maak een zoeker die van een lokaal nummer het internationale nummer bepaalt.
 *
 *   bevestig(kandidaat) → truthy als WhatsApp dit nummer kent
 *
 * Het antwoord is er in zes smaken, en die zijn met opzet uit elkaar gehouden:
 *
 *   niet_lokaal    — het nummer was al internationaal; er valt niets te doen
 *   gevonden       — precies één kandidaat bevestigd
 *   meerdere       — twee kandidaten bevestigd; dat is een gok, dus nee
 *   geen           — alle kandidaten geprobeerd, geen enkele bevestigd
 *   mislukt        — er ging bij minstens één kandidaat iets mis; we WETEN het
 *                    niet
 *   niet_meetbaar  — deze whatsapp-web.js kan de vraag niet stellen
 *
 * WAT WEL EN NIET ONTHOUDEN WORDT. Alleen een echt antwoord gaat de cache in:
 * `gevonden`, `meerdere` en `geen`. Een mislukte poging niet.
 *
 * Dat onderscheid is niet theoretisch. `bevestig` gooit als WhatsApp nog niet
 * klaar is of de verbinding net wegviel, en de lidkaart wordt bij het opstarten
 * gebouwd — juist het moment waarop dat het vaakst gebeurt. Zou een mislukking
 * als `geen` de cache in gaan, dan stonden die zes nummers voorgoed op 'niet te
 * bepalen' tot iemand de service herstart, en niets zou zeggen dat het aan de
 * meting lag in plaats van aan het nummer.
 *
 * Zonder de cache zou een gesprek waarin Dave vijf berichten stuurt vijf keer
 * aan WhatsApp vragen of dat nummer bestaat. Vandaar: onthouden wat kennis is,
 * opnieuw proberen wat dat niet was.
 */
export function maakLandcodeZoeker({ bevestig, onMeting } = {}) {
  const cache = new Map();   // genormaliseerd lokaal nummer → uitkomst

  async function zoek(raw) {
    const c = normaliseerNummer(raw);
    if (!c) return { status: 'geen', nummer: null, kandidaten: 0, treffers: 0 };
    if (!c.startsWith('0')) return { status: 'niet_lokaal', nummer: c, kandidaten: 0, treffers: 0 };
    if (cache.has(c)) return cache.get(c);

    const kandidaten = kandidatenVoor(c);
    const treffers = [];
    let misluktCount = 0;
    let nietMeetbaar = false;
    for (const k of kandidaten) {
      let antwoord;
      try {
        // Elke kandidaat apart proberen; één fout mag de andere niet ophouden.
        antwoord = await bevestig(k);
      } catch (e) {
        // Een fout is geen 'nee'. Zie de uitleg hierboven: dit mag niet als
        // kennis blijven hangen.
        if (e && e.code === NIET_MEETBAAR) nietMeetbaar = true;
        else misluktCount += 1;
        continue;
      }
      if (antwoord) treffers.push(k);
    }

    let uit;
    if (nietMeetbaar) {
      // Deze bibliotheek kan de vraag niet stellen. Dat is iets anders dan
      // 'WhatsApp kent dit nummer niet' — precies het onderscheid waar de hele
      // LID-zoektocht op is stukgelopen.
      uit = { status: 'niet_meetbaar', nummer: null, kandidaten: kandidaten.length, treffers: 0 };
    } else if (misluktCount > 0) {
      uit = { status: 'mislukt', nummer: null, kandidaten: kandidaten.length, treffers: treffers.length };
    } else if (treffers.length === 1) {
      uit = { status: 'gevonden', nummer: treffers[0], kandidaten: kandidaten.length, treffers: 1 };
    } else {
      uit = { status: treffers.length > 1 ? 'meerdere' : 'geen',
              nummer: null, kandidaten: kandidaten.length, treffers: treffers.length };
    }

    // ALLEEN EEN ECHT ANTWOORD ONTHOUDEN. Een mislukte of onmeetbare poging is
    // geen kennis, en die volgende keer opnieuw proberen kost twee aanroepen.
    if (ONTHOUDBAAR.has(uit.status)) cache.set(c, uit);
    // Alleen de uitkomst en de aantallen; nooit het nummer zelf.
    if (typeof onMeting === 'function') onMeting(uit.status, uit.kandidaten, uit.treffers);
    return uit;
  }

  return {
    zoek,
    /** Alleen het aantal onthouden nummers. Nooit de nummers zelf. */
    aantalOnthouden: () => cache.size,
    /** Voor tests: de cache leegmaken zonder een nieuw proces. */
    vergeet: () => cache.clear(),
  };
}
