// api/_lib/phone-e164.js
//
// TELEFOONNUMMERS NAAR E.164 — EN NOOIT GOKKEN.
//
// ── WAT ER MISGING ──────────────────────────────────────────────────────
// GEMETEN op 16 september. Maxim zette zichzelf op een testevent met
// telefoon '0472223752'. Run 994c0636 ('Welkom + vragenlijst'):
//
//   stap 0  send_email      ok:true
//   stap 1  send_whatsapp   ok:FALSE — Meta 131009 (#131009)
//           "Het telefoonnummer is onjuist ingedeeld: Gebruik de volgende
//            indeling: +1234567890"   permanent:true
//
// Over alle event_attendees met is_test=false: 159 rijen met een nummer dat
// NIET aan ^\+[1-9][0-9]{7,14}$ voldoet (9 op komende events), 25 wel correct
// (23 op komende events), 10 zonder nummer. Het overgrote deel van de
// deelnemers heeft dus nooit een WhatsApp gekregen.
//
// Oorzaak: het deelnemerspad sloeg het nummer op precies zoals het getypt is.
//
// ── DE HARDE REGEL: NOOIT GOKKEN ────────────────────────────────────────
// '+' en '00' zijn EENDUIDIG — daar staat de landcode in en die nemen we over.
// Een enkele 0-prefix is dat NIET, en dat is geen theoretisch bezwaar:
//
//   06xxxxxxxx    Nederlands gsm
//   045x–049x     Belgisch gsm
//   040xxxxxxx    vastnummer Eindhoven — GEEN Belgisch gsm
//
// Hetzelfde '04'-begin betekent in NL iets anders dan in BE. Er is dus geen
// landcode af te leiden uit 'begint met 0' zonder te weten om welk land het
// gaat, en die informatie heeft een inschrijfformulier niet. Maxims eigen
// nummer is precies dat geval: '0472223752' is als +32472223752 een geldig
// Belgisch gsm, en als +31472223752 een nummer dat niet bestaat.
//
// Een verkeerde gok stuurt een WhatsApp met iemands factuur- of
// eventgegevens naar een wildvreemde. Dat is erger dan een foutmelding.
// Vandaar: eenduidig omzetten, en anders WEIGEREN met een leesbare melding
// die om de landcode vraagt.
//
// ── TWEE BELEIDSREGELS, ÉÉN PARSER ──────────────────────────────────────
// Er stond al een omzetter in de repo: _normalizeToE164(raw, line) in
// api/softphone-call-log.js. Die is hierheen verhuisd als `normaliseerLenient`,
// LETTERLIJK en met hetzelfde gedrag, want hij hoort bij een ander soort pad:
//
//   · normaliseerLenient  — een LOG. Onparseerbaar komt er rauw weer uit,
//     zodat de regel toch geschreven wordt. Mag een 0-prefix wél op de lijn
//     mappen, want daar kiest een mens die lijn expliciet ('nl' of 'be').
//   · normaliseerStrict   — een SEND-pad. Weigert alles wat niet eenduidig
//     is, want wat hier doorglipt gaat als bericht de deur uit.
//
// Ze delen de parsing, niet het beleid. Zo is er één plek waar de vorm van een
// nummer bepaald wordt, zonder dat de tolerante keuze van het log-pad in het
// send-pad terechtkomt (of omgekeerd).

// Dezelfde vorm-eis waarmee de 159 rijen geteld zijn, zodat een meting voor en
// na vergelijkbaar blijft. Meta wil exact dit.
export const E164_RE = /^\+[1-9][0-9]{7,14}$/;

export function isE164(waarde) {
  return typeof waarde === 'string' && E164_RE.test(waarde);
}

// Scheidingstekens die mensen intypen. De strikte variant haalt ook punten weg
// ('06.12.34.56.78'); de lenient variant NIET, omdat dat het gedrag van
// softphone-call-log zou wijzigen en dat buiten deze wijziging valt.
function _schoon(raw, { punten }) {
  let s = String(raw).trim().replace(/\s+/g, '').replace(/[-()]/g, '');
  if (punten) s = s.replace(/\./g, '');
  return s;
}

/**
 * SEND-PAD. Zet om wat eenduidig is, weiger de rest.
 *
 * @param {*} raw  wat de gebruiker of het formulier aanleverde
 * @returns {{ e164: ?string, fout: ?string, ambigu: boolean }}
 *   e164   gezet = bruikbaar nummer (of null als er geen nummer gegeven is)
 *   fout   gezet = WEIGEREN, met een tekst die om de landcode vraagt
 *   ambigu true  = er stond wel iets, maar de landcode ontbreekt
 */
export function normaliseerStrict(raw) {
  // Geen nummer is geen fout. Niet iedereen geeft een telefoonnummer, en dat
  // mag een inschrijving niet blokkeren.
  if (raw == null) return { e164: null, fout: null, ambigu: false };
  const s = _schoon(raw, { punten: true });
  if (!s) return { e164: null, fout: null, ambigu: false };

  // EENDUIDIG 1 — de landcode staat er al.
  if (s.startsWith('+')) {
    if (isE164(s)) return { e164: s, fout: null, ambigu: false };
    return {
      e164: null, ambigu: false,
      fout: 'Het telefoonnummer "' + String(raw).trim() + '" begint met + maar heeft geen '
          + 'geldige vorm. Verwacht: een landcode en 8 tot 15 cijfers, bijvoorbeeld '
          + '+31612345678 of +32472223752.',
    };
  }

  // EENDUIDIG 2 — 00 is de internationale uitbelcode; wat erna komt is de
  // landcode. Even betrouwbaar als een +.
  if (s.startsWith('00')) {
    const kandidaat = '+' + s.slice(2);
    if (isE164(kandidaat)) return { e164: kandidaat, fout: null, ambigu: false };
    return {
      e164: null, ambigu: false,
      fout: 'Het telefoonnummer "' + String(raw).trim() + '" begint met 00 maar levert geen '
          + 'geldig nummer op. Verwacht: 00, dan de landcode, dan het nummer zonder de 0 '
          + 'ervoor — bijvoorbeeld 0031612345678.',
    };
  }

  // NIET EENDUIDIG — hier stopt het, en met opzet.
  //
  // Een 0-prefix zegt niets over het land (zie de kop van dit bestand), en een
  // nummer zonder 0 en zonder + is evengoed onbepaald: '612345678' kan een
  // Nederlands gsm zonder 0 zijn, en '31612345678' een Nederlands nummer
  // zonder +. Alles wat we hier zouden kiezen is een gok, en een gok stuurt
  // het bericht mogelijk naar een vreemde.
  return {
    e164: null, ambigu: true,
    fout: 'Het telefoonnummer "' + String(raw).trim() + '" mist de landcode, en die is niet '
        + 'te raden: 06… is Nederlands mobiel, 047… is Belgisch mobiel, maar 040… is een '
        + 'Nederlands vastnummer. Vul het nummer in met landcode — bijvoorbeeld '
        + '+31612345678 (NL) of +32472223752 (BE).',
  };
}

/**
 * LOG-PAD. Letterlijk het gedrag van _normalizeToE164 uit
 * api/softphone-call-log.js, hierheen verhuisd zodat er één parser is.
 *
 * Best-effort: onparseerbaar komt er rauw weer uit zodat de regel toch
 * geschreven wordt. Geen exception, geen 400 — dit is een LOG, geen SEND, en
 * data-verlies is daar erger dan een minder-net formaat.
 *
 * De 0-prefix mag hier wél op de lijn gemapt worden: de beller kiest 'nl' of
 * 'be' expliciet, dus het land is bekend en er wordt niets geraden.
 *
 * @param {*} raw
 * @param {string} line  'nl' | 'be'
 */
export function normaliseerLenient(raw, line) {
  if (!raw) return null;
  const s = _schoon(raw, { punten: false });
  if (!s) return null;
  if (s.startsWith('+'))  return s;                 // al E.164
  if (s.startsWith('00')) return '+' + s.slice(2);  // 00-prefix
  if (s.startsWith('0')) {
    if (line === 'nl') return '+31' + s.slice(1);
    if (line === 'be') return '+32' + s.slice(1);
  }
  return s;   // short-code / extension / onbekend → raw, geen 400
}

// ── DERDE BELEID: NL/BE VOOR BEL- EN LEADPADEN ──────────────────────────
//
// Gebruikt voor opvolging_taken.telefoon, leads.telefoon_e164 (de werklijst
// belt daarmee) en het nummer dat naar GHL gaat.
//
// GEMETEN na de eerste datafix: leads.telefoon_e164 was op meer manieren
// kapot dan alleen 04 → +31. Allemaal door een helper die '+31' voor alles
// plakte wat niet met + begon, of een 0 altijd als Nederlands las:
//   0475716706     → +31475716706    (lokaal Belgisch werd NL)
//   470497423      → +31470497423    (Belgisch gsm zonder 0)
//   0032471134787  → +3132471134787  (00 niet herkend)
//   00310633298551 → +31310633298551 (00 + trunk-nul)
//   +310682610365  → ongewijzigd     (trunk-nul na +31 bleef staan)
//   31 0612348963  → +31310612348963 (landcode zonder +)
// En +32470085329 → +31470085329: dat komt uit geen enkele JS-helper in deze
// repo; zie de PR-beschrijving (upsert_lead in de database).
//
// GEMETEN op 28 september. Belgische gsm-nummers in lokaal formaat
// ('0475716706') kwamen in opvolging_taken.telefoon terecht als
// '+31475716706'. Dat nummer bestaat niet; de softphone kiest dan de NL-lijn
// en de operator weigert na 1-2 seconden (call_log: duration_sec 1-2,
// outcome_hint no_answer). René Frederix had één taak met '0475716706' en
// een nieuwere met '+31475716706'; Rayan Kerkab stond op een event met
// +32471644261 en als opvolgtaak met +31471644261.
//
// De lus: een taak met een lokaal nummer wordt ingepland → het RAUWE nummer
// gaat naar GHL (contacts/upsert) → GHL vult zijn standaardland NL in → de
// appointment-poll leest '+31…' terug in follow_up_appointments.lead_phone
// → de opwarm-cron maakt daar een nieuwe taak van. Niemand in onze code
// plakte +31 ervoor; we gaven het nummer alleen ongenormaliseerd door aan
// iemand die het wél deed.
//
// WAAROM HIER WEL EEN AANNAME, EN BIJ normaliseerStrict NIET.
// Strict hoort bij een SEND-pad: een WhatsApp met iemands gegevens. Een
// verkeerde gok daar lekt informatie naar een vreemde. Dit is een BELPAD:
// een mens kiest het nummer aan, ziet de lijnkeuze en hoort wie opneemt. En
// het alternatief is niet 'niets doen' — dat is GHL laten gokken, altijd NL.
//
// DE AFWEGING BIJ 04 MET 10 CIJFERS. In NL beginnen ook vaste netnummers met
// 04 (040 Eindhoven, 046, 047x, 049x), en die zijn óók 10 cijfers — precies
// zo lang als een lokaal Belgisch gsm-nummer (045x-049x). Het nummer alleen
// beslist dat niet. We kiezen +32: onze leads zijn overwegend Vlaams, en een
// Nederlandse lead geeft vrijwel altijd een 06-nummer op. Een NL-vastnummer
// in 04 wordt hierdoor verkeerd; dat is zichtbaar in de lijnkeuze en
// overschrijfbaar, en zeldzamer dan het omgekeerde.
//
// Alleen 045-049 geldt als Belgisch gsm. 040-044 met 10 cijfers bestaat in
// België niet (gsm = 045x-049x, vast = 9 cijfers), dus dat is zeker een
// Nederlands vastnummer (040 Eindhoven, 043 Maastricht) en gaat naar +31.
//
// TWIJFEL = RAUW LATEN + LOGGEN. Fout aantal cijfers, geen 0/+/00-prefix, of
// een +31/+32 met een onmogelijke lengte: dan blijft het nummer zoals het
// binnenkwam. Zo valt het op in de lijst in plaats van stil een verkeerd
// land te krijgen.

// Lengte van het nationale deel (na de landcode) die we accepteren.
const NATIONAAL_LENGTE = { '31': [9], '32': [8, 9] };

// Een landveld van een formulier naar een landcode. Alleen NL en BE: voor
// andere landen weten we de lokale nummering niet, dus dan val je terug op
// de regel.
function _landcode(land) {
  if (land == null) return null;
  const s = String(land).trim().toLowerCase().replace(/[^a-zë+0-9]/g, '');
  if (['nl', 'nld', 'nederland', 'netherlands', 'thenetherlands', 'holland', '31', '+31'].includes(s)) return '31';
  if (['be', 'bel', 'belgie', 'belgië', 'belgium', 'belgique', '32', '+32'].includes(s)) return '32';
  return null;
}

function _geldigVoorLand(code, nationaal) {
  const lengtes = NATIONAAL_LENGTE[code];
  if (!lengtes) return true; // ander land: alleen de E.164-vorm telt
  return lengtes.includes(nationaal.length);
}

/**
 * NL/BE-NORMALISATIE voor bel- en leadpaden. Pure functie — logt niet zelf
 * (zie telefoonNlBe).
 *
 * @param {*} raw
 * @param {{ land?: string }} [opties]  landveld van de bron, als dat er is
 * @returns {{ telefoon: ?string, e164: ?string, zeker: boolean, reden: string }}
 *   telefoon  wat opgeslagen wordt: het E.164-nummer, of bij twijfel het
 *             rauwe (getrimde) nummer
 *   e164      gezet als omgezet, anders null
 *   zeker     true = landcode stond erin of kwam uit het landveld
 *   reden     korte uitleg, voor het log
 */
export function normaliseerNlBe(raw, { land = null } = {}) {
  if (raw == null) return { telefoon: null, e164: null, zeker: false, reden: 'geen nummer' };
  const rauw = String(raw).trim();
  const s = rauw.replace(/[\s\-().\/]/g, '');
  if (!s) return { telefoon: null, e164: null, zeker: false, reden: 'geen nummer' };

  const twijfel = (reden) => ({ telefoon: rauw, e164: null, zeker: false, reden });
  const klaar = (code, nationaal, zeker, reden) => {
    const e164 = '+' + code + nationaal;
    return { telefoon: e164, e164, zeker, reden };
  };

  // 1 · + of 00: de landcode staat er al en wint, ook van een landveld.
  //     Voor +31/+32 gaat een trunk-nul na de landcode eraf ('+31 06…',
  //     '0031 06…' → +316…) en wordt de lengte gecontroleerd — '+3147979884'
  //     is een cijfer te kort.
  if (s.startsWith('+') || s.startsWith('00')) {
    const d = s.startsWith('+') ? s.slice(1) : s.slice(2);
    if (!/^\d+$/.test(d) || d.startsWith('0')) return twijfel('geen geldige landcode');
    for (const code of Object.keys(NATIONAAL_LENGTE)) {
      if (!d.startsWith(code)) continue;
      const nationaal = d.slice(code.length).replace(/^0/, '');
      if (!_geldigVoorLand(code, nationaal) || (code === '32' && !_beVorm(nationaal))) {
        return twijfel('+' + code + ' met fout aantal cijfers');
      }
      return klaar(code, nationaal, true, 'landcode aanwezig');
    }
    if (!isE164('+' + d)) return twijfel('geen geldige E.164-vorm');
    return { telefoon: '+' + d, e164: '+' + d, zeker: true, reden: 'landcode aanwezig' };
  }

  if (!/^\d+$/.test(s)) return twijfel('onbekende tekens');

  // 2 · Landcode zonder + ('31 0612348963', '32470085329'). Alleen als het
  //     nationale deel daarna precies klopt; een lokaal nummer begint nooit
  //     met 31/32 zonder 0, en een te kort nummer ('3147979884') blijft rauw.
  if (!s.startsWith('0')) {
    for (const code of Object.keys(NATIONAAL_LENGTE)) {
      if (!s.startsWith(code)) continue;
      const nationaal = s.slice(code.length).replace(/^0/, '');
      if (_geldigVoorLand(code, nationaal) && (code === '31' || _beVorm(nationaal))) {
        return klaar(code, nationaal, true, 'landcode ' + code + ' zonder +');
      }
    }
    // 3 · Nationaal nummer zonder 0 van 9 cijfers. 45x-49x is een Belgisch
    //     gsm ('470497423'), 6x een Nederlands gsm: allebei in het andere
    //     land onmogelijk met 9 cijfers (BE vast = 8, NL heeft geen 4x-gsm).
    if (s.length === 9 && /^4[5-9]/.test(s)) return klaar('32', s, false, 'Belgisch gsm zonder 0');
    if (s.length === 9 && s.startsWith('6'))  return klaar('31', s, false, 'Nederlands gsm zonder 0');
    return twijfel('geen 0, + of 00 ervoor');
  }

  const nationaal = s.slice(1);
  if (nationaal.startsWith('0')) return twijfel('dubbele 0 zonder landcode');

  // 4 · EENDUIDIGE NUMMERS WINNEN VAN HET LANDVELD (2 okt, akkoord Maxim).
  //     Een formulier staat vaak standaard op NL; een Vlaamse lead tikt dan
  //     zijn gsm in zonder het land te wijzigen. Gemeten: Maxims testboeking
  //     via /agenda/planning kwam binnen als +31472223752 i.p.v. +32472223752.
  //     Twee vormen zeggen zelf welk land het is, en die winnen:
  //       0 + 45x-49x + 10 cijfers → Belgisch gsm  → +32
  //       06 + 10 cijfers          → Nederlands gsm → +31
  //     Een NL-vastnummer in 045-049 (Heerlen, Roermond, …) wordt daardoor
  //     ook mét landveld NL als Belgisch gelezen — dezelfde afweging als in
  //     stap 5 hieronder, nu consequent. Tweeling van dfo-website PR #88.
  if (nationaal.length === 9 && /^4[5-9]/.test(nationaal)) return klaar('32', nationaal, false, '045-049 + 10 cijfers → Belgisch gsm (wint van landveld)');
  if (nationaal.length === 9 && nationaal.startsWith('6'))  return klaar('31', nationaal, false, '06 → Nederlands gsm (wint van landveld)');

  // 5 · Niet eenduidig (vast nummer, andere lengte): het landveld beslist.
  const code = _landcode(land);
  if (code) {
    // Een Belgisch nummer van 9 cijfers bestaat alleen als gsm (4x); een
    // andere 9-cijferige reeks met landveld BE is geen nummer — rauw laten.
    if (_geldigVoorLand(code, nationaal) && (code === '31' || _beVorm(nationaal))) {
      return klaar(code, nationaal, true, 'landveld ' + code);
    }
    return twijfel('landveld +' + code + ' maar fout aantal cijfers');
  }

  // 6 · Zonder landveld: de regel voor een lokaal vast 0-nummer.
  if (nationaal.length === 9) return klaar('31', nationaal, false, '0 + 9 cijfers → Nederlands vast');
  if (nationaal.length === 8) return klaar('32', nationaal, false, '0 + 8 cijfers → Belgisch vast');
  return twijfel('fout aantal cijfers voor NL/BE');
}

// Een Belgisch nationaal nummer van 9 cijfers moet een gsm (4x) zijn; 8
// cijfers is vast. Voorkomt dat '32' + een willekeurige reeks erdoor glipt.
function _beVorm(nationaal) {
  return nationaal.length === 8 || nationaal.startsWith('4');
}

/**
 * Wat er in opvolging_taken.telefoon, leads.telefoon_e164 of naar GHL gaat.
 * Logt bij twijfel, zodat een rauw gebleven nummer in de Vercel-logs terug te
 * vinden is.
 *
 * @param {*} raw
 * @param {{ land?: string, bron?: string }} [opties]
 * @returns {?string}
 */
export function telefoonNlBe(raw, { land = null, bron = 'onbekend' } = {}) {
  const r = normaliseerNlBe(raw, { land });
  if (r.telefoon && !r.e164) {
    console.warn('[telefoon-nl-be] niet omgezet, rauw bewaard:',
      { bron, telefoon: r.telefoon, reden: r.reden });
  }
  return r.telefoon;
}
