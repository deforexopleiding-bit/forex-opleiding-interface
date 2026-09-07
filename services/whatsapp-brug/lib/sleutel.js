// services/whatsapp-brug/lib/sleutel.js
//
// DE SLEUTEL VAN DE LIDKAART, EN DE VORM ERVAN.
//
// De kaart wordt gevuld met wat getNumberId teruggeeft, en bevraagd met wat er
// in een binnenkomende jid staat. Als die twee niet dezelfde vorm hebben, slaan
// we op onder een sleutel waar nooit iemand naar vraagt — en dan mist de kaart
// zonder één foutmelding. Op 7 september was dat de stand: 29 koppelingen in de
// kaart, en toch 67 van de 71 opzoekingen mis.
//
// WAT HIER VERMOEDELIJK GEBEURT — en dit is een vermoeden dat deze module
// MEET in plaats van aanneemt.
//
// Een WhatsApp-jid kan een apparaat-achtervoegsel dragen: `<lid>:<apparaat>@lid`.
// whatsapp-web.js 1.34.7 kent LID's niet en splitst dat achtervoegsel nergens
// af — er staat in de hele bibliotheek geen enkele verwijzing naar `device` of
// `@lid`. De brug plukte de cijfers met `replace(/\D/g, '')`, en dat LAST het
// achtervoegsel juist vast aan het nummer: `1234567890123:5` wordt
// `12345678901235`. Dertien cijfers worden er veertien, en met een
// tweecijferig apparaat vijftien — precies de vormen lid/14 en lid/15 die
// binnenkomen, terwijl de kaart de kale LID als sleutel heeft.
//
// De kaart bewaart daarom BEIDE vormen, en de teller houdt apart bij hoe vaak
// de kale sleutel de redding was. Blijft die teller op nul, dan klopt het
// vermoeden niet en is er niets stilletjes 'gerepareerd'.

/**
 * De cijfers van een jid-gebruiker, met en zonder apparaat-achtervoegsel.
 *
 * Geeft drie dingen terug:
 *   vol   — alle cijfers, zoals de brug ze tot nu toe plukte
 *   basis — alleen het deel vóór de eerste ':' of '_'
 *   apparaat — of er zo'n achtervoegsel was
 *
 * `_` staat erbij omdat WhatsApp die scheiding in sommige serialisaties
 * gebruikt. Onbekende scheidingstekens vallen vanzelf in `vol`; die zien we dan
 * terug als een vorm die nergens op matcht, en dát is de melding.
 */
export function deelSleutel(ruw) {
  const tekst = String(ruw == null ? '' : ruw);
  const voorApenstaart = tekst.split('@')[0];
  const vol = voorApenstaart.replace(/\D/g, '');
  const gesneden = voorApenstaart.split(/[:_]/)[0];
  const basis = gesneden.replace(/\D/g, '');
  return {
    vol   : vol || null,
    basis : basis || null,
    apparaat: !!basis && basis !== vol,
  };
}

/**
 * De VORM van een sleutel, zonder de sleutel zelf.
 *
 * 'lid/13' of 'lid/13+apparaat'. Een domein, een lengte en een ja/nee — geen
 * identificerend gegeven, en het beantwoordt precies de vraag: schrijven we weg
 * onder dezelfde soort sleutel als waarmee we zoeken?
 */
export function sleutelVorm(ruw) {
  const tekst = String(ruw == null ? '' : ruw);
  const stuk = tekst.split('@');
  const domein = stuk.length > 1 ? String(stuk[1]).toLowerCase() : 'geen_domein';
  const bekend = ['c.us', 'lid', 'g.us', 's.whatsapp.net', 'broadcast'];
  const d = bekend.includes(domein) ? domein : (domein === 'geen_domein' ? domein : 'anders');
  const { basis, apparaat } = deelSleutel(tekst);
  return d + '/' + (basis ? basis.length : 0) + (apparaat ? '+apparaat' : '');
}

// ── Is dit een telefoonnummer, of iets anders? ──────────────────────────────
//
// De aanleiding: getContactById gaf bij een LID het LID terug, en dat ging als
// 'nummer' de leadlijst in. De teller noemde dat opgelost.contact — succes dus,
// terwijl er niets vertaald was. Zolang een teller succes zegt bij een fout
// antwoord blijven we hierop stuklopen.
//
// TWEE CONTROLES, EN DE EERSTE IS DE EXACTE.
//
// 1. Kreeg je terug wat je erin stopte? Vroeg je 'wie is 1234…@lid' en komt
//    1234… terug, dan is dat geen vertaling maar dezelfde identiteit opnieuw.
//    Dat is een gelijkheidstest, geen gok — en hij vangt precies de gevallen
//    contact/14 en contact/15 uit de meting van 7 september.
//
// 2. Kan dit überhaupt een telefoonnummer zijn? E.164 staat maximaal vijftien
//    cijfers toe, dus op lengte alleen is een lang LID niet met zekerheid van
//    een nummer te onderscheiden. Daarom is deze tweede controle bewust ruim:
//    hij weigert alleen wat écht niet kan. Onze leads zijn Belgisch en
//    Nederlands — elf cijfers met landcode, tien of negen lokaal genoteerd — en
//    veertien of meer is dan geen telefoonnummer meer. De grens ligt op
//    dertien, zodat er ruimte blijft voor landen met langere nummers zonder dat
//    de LID's van veertien en vijftien er doorheen glippen.
//
// Controle 1 is de scherpe; controle 2 is het vangnet voor het geval WhatsApp
// een ANDER lang getal teruggeeft dan de jid waarmee we vroegen.

export const NUMMER_MIN_CIJFERS = 8;
export const NUMMER_MAX_CIJFERS = 13;

/**
 * Kan deze reeks cijfers een telefoonnummer zijn?
 *
 * Alleen de vorm — of het nummer bij ons bekend is, beslist de leadlijst.
 */
export function kanTelefoonnummerZijn(cijfers) {
  const c = String(cijfers == null ? '' : cijfers).replace(/\D/g, '');
  if (!c) return false;
  return c.length >= NUMMER_MIN_CIJFERS && c.length <= NUMMER_MAX_CIJFERS;
}

/**
 * Is dit antwoord bruikbaar als telefoonnummer voor deze vraag?
 *
 * `kandidaat` is wat WhatsApp teruggaf, `gevraagdeJid` is waarmee we vroegen.
 * Geeft een reden terug in plaats van alleen true/false, zodat de teller kan
 * onderscheiden WAAROM iets onbruikbaar was.
 */
export function beoordeelKandidaat(kandidaat, gevraagdeJid) {
  const c = String(kandidaat == null ? '' : kandidaat).split('@')[0].replace(/\D/g, '');
  if (!c) return { ok: false, reden: 'leeg' };

  const gevraagd = deelSleutel(gevraagdeJid);
  // Controle 1 — dezelfde identiteit terug. Zowel tegen de volledige cijfers
  // als tegen de kale basis, want het achtervoegsel kan aan één kant staan.
  if (gevraagd.vol && (c === gevraagd.vol || c === gevraagd.basis)) {
    return { ok: false, reden: 'zelfde_als_vraag' };
  }
  // Controle 2 — dit kan geen telefoonnummer zijn.
  if (!kanTelefoonnummerZijn(c)) return { ok: false, reden: 'geen_nummervorm' };

  return { ok: true, reden: null, nummer: c };
}
