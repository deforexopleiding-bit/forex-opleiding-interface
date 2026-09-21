// api/_lib/iris/toon.js
//
// De regels waar elk bericht van Iris langs moet, en de poort die ze afdwingt.
//
// ── WAAROM DIT GEEN PROMPT IS ────────────────────────────────────────────────
// De regels uit sectie 5 van de opdracht staan ook in de instructie aan het
// model — daar horen ze, want een model dat weet wat de bedoeling is, schrijft
// beter. Maar ze staan hier ook, als controle achteraf, en dat is het stuk dat
// telt.
//
// Een instructie kan overtuigd worden. Een voldoende creatieve klant praat een
// model naar een zin die er niet had mogen staan, en een hallucinatie heeft
// helemaal geen overtuiging nodig. Een `if` kan niet overtuigd worden. Dus:
// het model krijgt de regels te horen, en daarna wordt de uitkomst nagekeken.
// Zelfde redenering als lesson learned 24 in CLAUDE.md over mandaten.
//
// ── DE ZES CONTROLES ─────────────────────────────────────────────────────────
//   1. [invullen] — een ontbrekend gegeven blokkeert de verzending. Altijd.
//   2. Geen persoonsnaam of botnaam als ondertekening.
//   3. Geen juridische dreiging.
//   4. Geen bedragen of factuurnummers in een neutrale herinnering.
//   5. Niet leeg, niet eindeloos lang.
//   6. Geen verkooppraat.
//
// Controle 1 is de enige die ALTIJD blokkeert, ook bij een mens die op
// Verstuur drukt. De andere vijf zijn waarschuwingen: een mens die bewust zijn
// eigen naam eronder zet, mag dat. De opdracht zegt dat met zoveel woorden:
// "tenzij Maxim bij goedkeuring zijn eigen naam kiest".

/** Het merkteken voor een gegeven dat Iris niet had. */
export const ONTBREEKT = '[invullen]';

/** Hoe lang een WhatsApp-bericht hoogstens mag zijn. Meta's eigen grens. */
export const MAX_WA = 4096;

/** Hoe lang een mail hoogstens mag zijn voordat het een document wordt. */
export const MAX_MAIL = 20000;

/** De ondertekening die automatische berichten dragen. */
export const ONDERTEKENING = 'Team De Forex Opleiding';

/**
 * Woorden die een juridische dreiging aankondigen.
 *
 * Bewust ruim: liever een waarschuwing te veel dan een deurwaarder in een
 * bericht dat niemand heeft goedgekeurd. De Forex Opleiding NL B.V. valt onder
 * Nederlands recht (KvK 88922421), en zo'n zin is geen stijlkwestie maar een
 * toezegging die nagekomen moet worden.
 */
export const JURIDISCHE_WOORDEN = Object.freeze([
  'deurwaarder', 'incassobureau', 'incasso-bureau', 'rechtbank', 'dagvaarding',
  'gerechtelijke', 'gerechtelijk', 'juridische stappen', 'juridisch stappen',
  'advocaat', 'aansprakelijk stellen', 'in gebreke stellen', 'ingebrekestelling',
  'beslag', 'loonbeslag', 'bkr', 'blacklist', 'zwarte lijst',
]);

/** Woorden die naar verkoop rieken. In een betalingsgesprek staan die verkeerd. */
export const VERKOOP_WOORDEN = Object.freeze([
  'aanbieding', 'korting', 'actie geldig', 'nu inschrijven', 'upgrade',
  'exclusieve kans', 'laatste plaatsen', 'mis het niet',
]);

/** Een bedrag in euro's, in de vormen die een model gebruikt. */
const BEDRAG_RE = /(?:€\s?\d|eur\s?\d|\d+[.,]\d{2}\s?(?:euro|eur|€))/i;

/** Een factuurnummer: F-123, FACT2026-001, factuur 1234. */
const FACTUURNUMMER_RE = /\b(?:f|fact|factuur|inv)[\s\-.]?\d{3,}\b/i;

/** Een datum: 12-09-2026, 12/09, 12 september. */
const DATUM_RE = /\b(?:\d{1,2}[-/]\d{1,2}(?:[-/]\d{2,4})?|\d{1,2}\s+(?:januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december))\b/i;

/**
 * Kijk een tekst na.
 *
 * @param {string} tekst
 * @param {object} opties
 * @param {'whatsapp'|'email'} opties.kanaal
 * @param {boolean} opties.neutraleHerinnering  true bij een bericht dat geen
 *   bedragen, factuurnummers of vervaldata mag noemen
 * @param {boolean} opties.doorMens  true als een mens op Verstuur drukt
 * @returns {{mag: boolean, blokkades: string[], waarschuwingen: string[]}}
 */
export function keurTekst(tekst, { kanaal = 'whatsapp', neutraleHerinnering = false, doorMens = false } = {}) {
  const s = String(tekst ?? '');
  const blokkades = [];
  const waarschuwingen = [];

  // 1. Ontbrekende gegevens. Dit is de enige die altijd blokkeert.
  if (s.includes(ONTBREEKT)) {
    blokkades.push(
      'Er staat nog [invullen] in de tekst. Iris had dat gegeven niet; ' +
      'het verzinnen ervan is erger dan het bericht niet sturen.'
    );
  }

  // 5. Leeg of eindeloos.
  const kaal = s.trim();
  if (!kaal) {
    blokkades.push('De tekst is leeg.');
  } else {
    const max = kanaal === 'email' ? MAX_MAIL : MAX_WA;
    if (kaal.length > max) {
      blokkades.push(`De tekst is ${kaal.length} tekens; het maximum is ${max}.`);
    }
  }

  const laag = s.toLowerCase();

  // 3. Juridische dreiging.
  for (const woord of JURIDISCHE_WOORDEN) {
    if (laag.includes(woord)) {
      const melding = `Er staat "${woord}" in de tekst. Dreigen met juridische stappen mag alleen als Maxim dat per dossier goedkeurt.`;
      if (doorMens) waarschuwingen.push(melding);
      else blokkades.push(melding);
      break;
    }
  }

  // 4. Een neutrale herinnering noemt geen cijfers.
  if (neutraleHerinnering) {
    if (BEDRAG_RE.test(s)) waarschuwingen.push('Een neutrale herinnering hoort geen bedrag te noemen.');
    if (FACTUURNUMMER_RE.test(s)) waarschuwingen.push('Een neutrale herinnering hoort geen factuurnummer te noemen.');
    if (DATUM_RE.test(s)) waarschuwingen.push('Een neutrale herinnering hoort geen vervaldatum te noemen.');
  }

  // 6. Verkooppraat.
  for (const woord of VERKOOP_WOORDEN) {
    if (laag.includes(woord)) {
      waarschuwingen.push(`"${woord}" klinkt als verkoop. In een betalingsgesprek staat dat verkeerd.`);
      break;
    }
  }

  return { mag: blokkades.length === 0, blokkades, waarschuwingen };
}

/**
 * Haal een persoonlijke ondertekening weg en zet de juiste eronder.
 *
 * Automatische berichten komen van het bedrijf, niet van een persoon en niet
 * van een bot. Dezelfde lijn als de aanmaanmotor al aanhoudt: een klant hoort
 * De Forex Opleiding, geen naam die hij morgen niet kan terugvinden.
 *
 * Bij een mens die zijn eigen naam kiest, blijft die staan.
 *
 * @param {string} tekst
 * @param {object} opties
 * @param {string|null} opties.eigenNaam  de naam die een mens koos, of null
 */
export function zetOndertekening(tekst, { kanaal = 'whatsapp', eigenNaam = null } = {}) {
  let s = String(tekst ?? '').trimEnd();

  // Weg met wat het model er zelf onder zette. Het model noemt zichzelf soms
  // Iris, en daar hebben we het uitdrukkelijk niet over: Iris is de naam van
  // het gereedschap, niet van een medewerker.
  s = s.replace(/\n+\s*(met vriendelijke groet|vriendelijke groet|groeten|groetjes)[,!]?\s*\n+\s*(iris|joost|het team|team)?[^\n]{0,60}$/i, '');
  s = s.replace(/\n+\s*[-–—]{0,2}\s*(iris|joost)\s*$/i, '');

  s = s.trimEnd();
  if (!s) return s;

  // WhatsApp krijgt geen ondertekening. Dat is een chat, geen brief, en een
  // handtekening onder elk berichtje leest als een automaat.
  if (kanaal !== 'email') return s;

  const naam = eigenNaam ? String(eigenNaam).trim() : ONDERTEKENING;
  return `${s}\n\nMet vriendelijke groet,\n${naam}`;
}

/**
 * Markeer een gegeven dat we niet hebben.
 *
 * Gebruik dit overal waar een waarde uit het dossier hoort te komen en er niet
 * is. De poort hierboven zorgt dan dat het bericht niet vertrekt. Dat is
 * bewust onhandig: een bericht dat blijft hangen omdat er een bedrag ontbreekt
 * is een ergernis van één minuut; een verzonnen bedrag is een gesprek van een
 * halfuur en een klant die je nooit meer gelooft.
 */
export function ontbrekend(watHetHoortTeZijn) {
  return `${ONTBREEKT}${watHetHoortTeZijn ? ` (${watHetHoortTeZijn})` : ''}`;
}

/** De regels, in de vorm die aan het model wordt voorgelegd. */
export const TOON_INSTRUCTIE = [
  'Toon en regels:',
  '',
  '- Schrijf Nederlands. Neem de toets van de klant over: schrijft hij Vlaams,',
  '  schrijf dan Vlaams; schrijft hij Nederlands, schrijf dan Nederlands.',
  '- Professioneel en met begrip, maar duidelijk. Begrip tonen, grenzen helder',
  '  houden, niet onnodig hard. Nooit verkooppraat.',
  '- Kort. Drie tot vijf zinnen bij WhatsApp, iets meer bij mail.',
  '- Onderteken niet met een persoonsnaam en niet met je eigen naam. Het bericht',
  '  komt van De Forex Opleiding.',
  '- Verzin NOOIT een feit, een bedrag, een factuurnummer of een datum. Staat het',
  `  gegeven niet in het dossier hieronder, schrijf dan letterlijk ${ONTBREEKT}`,
  '  op die plek. Het bericht wordt dan tegengehouden en een mens vult het aan.',
  '  Dat is de bedoeling; een verzonnen bedrag is veel erger dan een bericht dat',
  '  even blijft liggen.',
  '- Dreig nooit met juridische stappen, een deurwaarder of een incassobureau.',
  '- Gaat het over een opzegging, een klacht of iets juridisch: schrijf geen',
  '  antwoord maar één zin waarin je zegt dat een mens hiernaar kijkt.',
].join('\n');
