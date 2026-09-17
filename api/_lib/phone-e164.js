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
