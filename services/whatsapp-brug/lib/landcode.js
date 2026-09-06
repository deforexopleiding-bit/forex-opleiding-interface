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
 * Het antwoord is er in vier smaken, en die zijn met opzet uit elkaar gehouden:
 *
 *   niet_lokaal — het nummer was al internationaal; er valt niets te doen
 *   gevonden    — precies één kandidaat bevestigd
 *   meerdere    — twee kandidaten bevestigd; dat is een gok, dus nee
 *   geen        — geen enkele kandidaat bevestigd
 *
 * De uitkomst wordt onthouden zolang het proces draait. Zonder die cache vraagt
 * een gesprek waarin Dave vijf berichten stuurt vijf keer aan WhatsApp of dat
 * nummer bestaat.
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
    for (const k of kandidaten) {
      try {
        // Elke kandidaat apart proberen; één fout mag de andere niet ophouden.
        if (await bevestig(k)) treffers.push(k);
      } catch (_) { /* deze kandidaat telt gewoon niet mee */ }
    }

    const uit = treffers.length === 1
      ? { status: 'gevonden', nummer: treffers[0], kandidaten: kandidaten.length, treffers: 1 }
      : { status: treffers.length > 1 ? 'meerdere' : 'geen',
          nummer: null, kandidaten: kandidaten.length, treffers: treffers.length };

    cache.set(c, uit);
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
