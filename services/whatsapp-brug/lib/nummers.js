// services/whatsapp-brug/lib/nummers.js
//
// Nummers normaliseren en het privacyfilter. Bewust zonder enkele dependency,
// zodat dit bestand overal draait en met een kale `node --test` te controleren is.
//
// LET OP — DIT BESTAND HEEFT EEN TWEELING
// api/_lib/whatsapp-brug-nummers.js in het CRM is regel voor regel hetzelfde.
// Dat is met opzet: de brug moet zelfstandig naar een VPS te kopiëren zijn
// zonder de rest van de repo mee te slepen. tests/whatsapp-brug-nummers.test.js
// importeert allebei en vergelijkt de uitkomsten, zodat ze niet uit elkaar
// kunnen lopen zonder dat de test rood wordt. Wijzig je hier iets, wijzig het
// daar dan ook.

/**
 * Alles wat geen cijfer is eruit, en de internationale 00-prefix naar niets
 * (die betekent hetzelfde als de +). Eén enkele voorloop-nul blijft staan: dat
 * is de nationale prefix en die valt niet zomaar weg te denken.
 *
 * WhatsApp levert nummers aan als '32470111222@c.us'; het CRM heeft ze in alle
 * notaties die mensen ooit hebben ingetypt.
 */
function normaliseerNummer(raw) {
  if (raw == null) return null;
  // '@c.us' / '@s.whatsapp.net' / '@g.us' eraf voordat we cijfers plukken —
  // anders sleept de suffix cijfers mee bij een groeps-id.
  const zonderSuffix = String(raw).split('@')[0];
  const cijfers = zonderSuffix.replace(/\D/g, '');
  if (!cijfers) return null;
  if (cijfers.startsWith('00')) return cijfers.slice(2) || null;
  return cijfers;
}

/** De laatste negen cijfers: de lokale variant zonder landcode. */
function nummerStaart(raw) {
  const c = normaliseerNummer(raw);
  return c && c.length >= 9 ? c.slice(-9) : null;
}

/**
 * De toegestane nummers, in een vorm waarop snel te matchen valt.
 *
 * Twee ingangen: de volledige reeks, en de laatste negen cijfers. Die tweede is
 * nodig omdat het CRM nummers ook lokaal genoteerd kan hebben ('0470111222')
 * terwijl WhatsApp altijd met landcode aankomt ('32470111222'). Zonder die
 * ingang zou het filter elk zulk nummer wegsturen en zou de hele brug stil
 * niets doen.
 *
 * De staart-ingang telt alleen als hij naar precies één nummer wijst. Twee
 * leads met dezelfde laatste negen cijfers is zeldzaam, maar dan is 'kies er
 * een' een gok — en bij een privacyfilter is gokken de verkeerde kant op.
 */
function bouwToegestaan(nummers) {
  const vol = new Set();
  const perStaart = new Map();
  for (const n of (Array.isArray(nummers) ? nummers : [])) {
    const c = normaliseerNummer(n);
    if (!c) continue;
    vol.add(c);
    const s = c.length >= 9 ? c.slice(-9) : null;
    if (!s) continue;
    if (!perStaart.has(s)) perStaart.set(s, new Set());
    perStaart.get(s).add(c);
  }
  const staarten = new Set();
  for (const [s, set] of perStaart) if (set.size === 1) staarten.add(s);
  return { vol, staarten, aantal: vol.size };
}

/**
 * HET PRIVACYFILTER.
 *
 * Staat dit nummer op de lijst van bekende leads? Zo niet, dan raakt het bericht
 * de service niet: niet doorsturen, niet loggen, niet onthouden. Daves
 * privécontacten lopen over dezelfde telefoon, en die gaan het CRM niet in.
 *
 * Standaard NEE. Een lege of ontbrekende lijst laat niets door — als de
 * lead-lijst niet opgehaald kon worden is 'even alles doorlaten' precies de
 * fout die je nooit wilt maken. Liever een uur niets dan één privégesprek.
 *
 * Groepsgesprekken ('...@g.us') vallen er altijd buiten: daar zitten per
 * definitie mensen in die niet op de lijst staan.
 */
function isToegestaan(raw, toegestaan) {
  if (!toegestaan || !(toegestaan.vol instanceof Set)) return false;
  if (typeof raw === 'string' && raw.includes('@g.us')) return false;
  const c = normaliseerNummer(raw);
  if (!c) return false;
  if (toegestaan.vol.has(c)) return true;
  const s = c.length >= 9 ? c.slice(-9) : null;
  return !!(s && toegestaan.staarten.has(s));
}

/**
 * Naar het formaat dat whatsapp-web.js verwacht om iets te versturen.
 * Zonder landcode kunnen we niet gokken welk land bedoeld is — dan liever
 * niets versturen dan een vreemde ergens ter wereld aanschrijven.
 */
function naarChatId(raw) {
  const c = normaliseerNummer(raw);
  if (!c || c.length < 10 || c.startsWith('0')) return null;
  return `${c}@c.us`;
}

export { normaliseerNummer, nummerStaart, bouwToegestaan, isToegestaan, naarChatId };
