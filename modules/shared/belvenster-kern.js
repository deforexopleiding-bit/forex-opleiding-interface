// modules/shared/belvenster-kern.js
//
// DE PURE BESLISSINGEN ACHTER HET BELVENSTER.
//
// Alles wat hier staat is te testen zonder browser, zonder SIP en zonder
// microfoon: welke lijn hoort bij dit nummer, mag deze INVITE al weg, en wat
// is er feitelijk gebeurd toen de call eindigde.
//
// ── WAAROM ER GEEN DREMPEL OP DUUR IN ZIT ─────────────────────────────────
// De verleiding is een regel als 'korter dan drie seconden is een misgreep'.
// Die houdt geen stand. Bij drie van de negen korte calls in de historie volgt
// binnen enkele minuten een ECHT gesprek — Anais op 6 september: 3 seconden en
// daarna 26 seconden gesproken; op 7 september twee keer 1 seconde en daarna
// 22 seconden. Dat is geen misgreep maar een mislukte eerste poging in een
// reeks die slaagde, en dat herbelgedrag brengt in twee van de drie gevallen
// juist iemand aan de lijn.
//
// Een drempel op duur zou dus precies het gedrag afpakken dat werkt — dezelfde
// fout als de grens van tien seconden: een getal dat iets anders meet dan het
// zegt.
//
// Wat wél klopt is niet hoe lang de call duurde maar WAT ER GEBEURDE:
//   · heeft de tegenpartij opgenomen? → dat weet je uit de SIP-staat;
//   · hebben wij afgebroken vóór de INVITE de deur uit ging? → dat weet je
//     omdat je hem zelf hebt tegengehouden.
// Allebei feiten uit het moment, geen gok achteraf op een duur.

// LADEN ALS KLASSIEK SCRIPT, niet als module: klx-softphone.js is er zelf ook
// een en kan dus niet importeren. Alles hangt aan window.BelvensterKern, en de
// tests draaien dit bestand ECHT in een vm — dezelfde aanpak als bij de
// browser-views, zodat er geen tweede kopie ontstaat om te testen.
(function (global) {
  'use strict';

/** Landnummers waar we een eigen lijn voor hebben. */
const LIJNEN = { nl: '31', be: '32' };
const STANDAARD_LIJN = 'nl';

/**
 * Welke lijn hoort bij dit nummer?
 *
 * Mensen nemen veel vaker op bij een binnenlands nummer, dus dit is geen
 * gemak maar conversie. De keuze blijft zichtbaar en overschrijfbaar; bij een
 * land waar we geen lijn voor hebben valt hij terug op de standaard EN zegt
 * hij dat, in plaats van stil iets te kiezen.
 */
function kiesLijn(nummer) {
  const d = String(nummer == null ? '' : nummer).replace(/\D/g, '');
  if (!d) return { lijn: STANDAARD_LIJN, reden: 'geen nummer', zeker: false };
  // 0032… en 32… allebei; een lokaal 0-nummer zegt niets over het land.
  const genormaliseerd = d.replace(/^00/, '');
  for (const [lijn, code] of Object.entries(LIJNEN)) {
    if (genormaliseerd.startsWith(code)) {
      return { lijn, reden: '+' + code, zeker: true };
    }
  }
  if (genormaliseerd.startsWith('0')) {
    return { lijn: STANDAARD_LIJN, reden: 'lokaal nummer zonder landcode', zeker: false };
  }
  return { lijn: STANDAARD_LIJN, reden: 'ander land (+' + genormaliseerd.slice(0, 3) + ')', zeker: false };
}

/** De zin onder de lijnkeuze. Bij onzekerheid zeggen we dát ook. */
function lijnUitleg(keuze, beschikbaar = ['nl', 'be']) {
  if (!keuze) return '';
  const naam = keuze.lijn === 'be' ? 'Belgische lijn' : 'Nederlandse lijn';
  if (!beschikbaar.includes(keuze.lijn)) {
    return `De ${naam} is niet beschikbaar; er wordt gebeld via de standaardlijn.`;
  }
  return keuze.zeker
    ? `${naam} gekozen op ${keuze.reden}.`
    : `Geen bekend landnummer (${keuze.reden}) — standaardlijn gekozen. Pas aan als dat niet klopt.`;
}

// ── De armeerperiode ──────────────────────────────────────────────────────
//
// HOE LANG. Kort genoeg dat het niet als vertraging voelt, lang genoeg om een
// misgreep op te vangen. Een mens die zich bedenkt na een verkeerde klik heeft
// daar in de praktijk twee tot vier tienden van een seconde voor nodig; onder
// de 400 ms vangt het venster de meeste misgrepen niet, en boven de 1000 ms
// gaat een gewone beller denken dat het scherm hangt.
//
// 700 ms zit daar tussenin, met een zichtbare aftelling zodat het geen
// onverklaarde stilte is maar een stap die je ziet gebeuren.
const ARMEER_MS = 700;

/**
 * Mag de INVITE weg?
 *
 * Drie uitkomsten, en de middelste is het hele punt: wie binnen het venster
 * afbreekt stuurt NOOIT een INVITE, en dan rinkelt er niets aan de andere
 * kant. Zodra de INVITE weg is helpt een CANCEL daar niet meer tegen — dat is
 * een grens van de techniek, geen keuze van ons.
 */
function beoordeelArmering({ gestartMs, nuMs, afgebroken, armeerMs = ARMEER_MS }) {
  if (afgebroken) return { actie: 'afbreken', invite: false, resterend: 0 };
  const verstreken = Math.max(0, Number(nuMs) - Number(gestartMs));
  if (verstreken >= armeerMs) return { actie: 'bellen', invite: true, resterend: 0 };
  return { actie: 'wachten', invite: false, resterend: armeerMs - verstreken };
}

// ── Wat er feitelijk gebeurde ─────────────────────────────────────────────

const AFGEBROKEN_VOOR_INVITE  = 'afgebroken_voor_invite';
const AFGEBROKEN_VOOR_OPNEMEN = 'afgebroken_voor_opnemen';

/**
 * De uitkomst van een call, uit de feiten van het moment.
 *
 * @param {object} p
 * @param {boolean} p.inviteVerstuurd  is de INVITE de deur uit gegaan?
 * @param {boolean} p.opgenomen        heeft de tegenpartij opgenomen (Established)?
 * @param {boolean} p.doorOns          hebben wij afgebroken?
 */
function bepaalUitkomst({ inviteVerstuurd, opgenomen, doorOns }) {
  // Nooit verstuurd: er is niets gebeurd. Geen belpoging, geen rij, en zeker
  // geen uitspraak over de lead.
  if (!inviteVerstuurd) {
    return { outcome: AFGEBROKEN_VOOR_INVITE, logboek: false, telt_als_poging: false,
      uitleg: 'Afgebroken voordat er gebeld werd; er is geen oproep verstuurd.' };
  }
  if (opgenomen) {
    return { outcome: 'answered', logboek: true, telt_als_poging: true,
      uitleg: 'De tegenpartij nam op.' };
  }
  if (doorOns) {
    // WIJ hebben afgebroken vóórdat er werd opgenomen. 'Niet opgenomen' zou
    // een uitspraak over de LEAD zijn terwijl het er een over ons is. Hij
    // wordt wel vastgelegd — het toestel heeft gerinkeld — maar telt niet als
    // belpoging en niet mee in de archiveerregel.
    return { outcome: AFGEBROKEN_VOOR_OPNEMEN, logboek: true, telt_als_poging: false,
      uitleg: 'Wij hebben afgebroken voordat er werd opgenomen.' };
  }
  return { outcome: 'no_answer', logboek: true, telt_als_poging: true,
    uitleg: 'De tegenpartij nam niet op.' };
}

  global.BelvensterKern = {
    LIJNEN, STANDAARD_LIJN, ARMEER_MS,
    AFGEBROKEN_VOOR_INVITE, AFGEBROKEN_VOOR_OPNEMEN,
    kiesLijn, lijnUitleg, beoordeelArmering, bepaalUitkomst,
  };
})(typeof window !== 'undefined' ? window : globalThis);
