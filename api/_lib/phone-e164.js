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

// ── DERDE BELEID: OPVOLGING (BELPAD) ─────────────────────────────────────
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
 * OPVOLGING-PAD. Pure functie — logt niet zelf (zie telefoonVoorOpvolging).
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
export function normaliseerOpvolging(raw, { land = null } = {}) {
  if (raw == null) return { telefoon: null, e164: null, zeker: false, reden: 'geen nummer' };
  const rauw = String(raw).trim();
  const s = rauw.replace(/[\s\-().\/]/g, '');
  if (!s) return { telefoon: null, e164: null, zeker: false, reden: 'geen nummer' };

  const twijfel = (reden) => ({ telefoon: rauw, e164: null, zeker: false, reden });

  // 1 · + of 00: de landcode staat er al. Overnemen, maar wel de lengte
  //     controleren voor NL/BE — '+3147979884' is een cijfer te kort.
  if (s.startsWith('+') || s.startsWith('00')) {
    const kandidaat = s.startsWith('+') ? s : '+' + s.slice(2);
    if (!isE164(kandidaat)) return twijfel('geen geldige E.164-vorm');
    const d = kandidaat.slice(1);
    for (const code of Object.keys(NATIONAAL_LENGTE)) {
      if (d.startsWith(code) && !_geldigVoorLand(code, d.slice(code.length))) {
        return twijfel('+' + code + ' met fout aantal cijfers');
      }
    }
    return { telefoon: kandidaat, e164: kandidaat, zeker: true, reden: 'landcode aanwezig' };
  }

  if (!/^\d+$/.test(s)) return twijfel('onbekende tekens');
  // Zonder 0 en zonder +: '3147979884' kan een vergeten + zijn, of een
  // nummer zonder 0. Niet raden.
  if (!s.startsWith('0')) return twijfel('geen 0, + of 00 ervoor');
  const nationaal = s.slice(1);

  // 2 · Landveld van de bron gaat voor.
  const code = _landcode(land);
  if (code) {
    if (_geldigVoorLand(code, nationaal)) {
      const e164 = '+' + code + nationaal;
      return { telefoon: e164, e164, zeker: true, reden: 'landveld ' + code };
    }
    return twijfel('landveld +' + code + ' maar fout aantal cijfers');
  }

  // 3 · De regel.
  let c = null;
  let reden = '';
  if (nationaal.length === 9 && /^4[5-9]/.test(nationaal)) { c = '32'; reden = '045-049 + 10 cijfers → Belgisch gsm'; }
  else if (nationaal.length === 9 && nationaal.startsWith('6')) { c = '31'; reden = '06 → Nederlands gsm'; }
  else if (nationaal.length === 9) { c = '31'; reden = '0 + 9 cijfers → Nederlands vast'; }
  else if (nationaal.length === 8) { c = '32'; reden = '0 + 8 cijfers → Belgisch vast'; }
  if (!c) return twijfel('fout aantal cijfers voor NL/BE');
  const e164 = '+' + c + nationaal;
  return { telefoon: e164, e164, zeker: false, reden };
}

/**
 * Wat er in opvolging_taken.telefoon (of naar GHL) gaat. Logt bij twijfel,
 * zodat een rauw gebleven nummer in de Vercel-logs terug te vinden is.
 *
 * @param {*} raw
 * @param {{ land?: string, bron?: string }} [opties]
 * @returns {?string}
 */
export function telefoonVoorOpvolging(raw, { land = null, bron = 'onbekend' } = {}) {
  const r = normaliseerOpvolging(raw, { land });
  if (r.telefoon && !r.e164) {
    console.warn('[telefoon-opvolging] niet omgezet, rauw bewaard:',
      { bron, telefoon: r.telefoon, reden: r.reden });
  }
  return r.telefoon;
}
