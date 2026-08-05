// api/_lib/vat-normalize.js
//
// Normaliseer + valideer BTW-nummers vóór ze naar Teamleader gaan. TL keurt
// spaties/punten/kleine letters af (HTTP 400), waardoor bedrijven zonder
// btw-nummer op de factuur belanden. Bewijs uit 41-bedrijven-inventarisatie
// (aug 2026): "BE 0729.599.851", "NL 8625.75.187.B01", "nl865112964B01",
// "0808.734.629" (BE zonder landcode), "BtwBE0677756222" (met tekst-prefix).
//
// Deze helper is PURE — geen DB/HTTP. Unit-testbaar. Roept nooit throw op
// niks; bij ongeldige input returnt 'em {ok:false, error, code}.
//
// Ondersteunde formaten (na normalisatie):
//   - BE + 10 cijfers                  (bv. BE0729599851)
//   - NL + 9 cijfers + B + 2 cijfers   (bv. NL862575187B01)
//
// Andere EU-landen: nu niet ondersteund. Als je die later toevoegt, breid
// LAND_PATTERNS + INFER_RULES uit.

// Formaat-regexen per landcode. Anchor-safe (^…$).
const LAND_PATTERNS = {
  BE: /^BE\d{10}$/,
  NL: /^NL\d{9}B\d{2}$/,
};

// Voorvoegsels die vóór de landcode kunnen staan — komen uit customer-input.
// Case-insensitive geregexd op geUpperCased input (na stap 2), dus we hoeven
// alleen hoofdletter-varianten te matchen.
const STRIP_PREFIXES = ['BTW', 'VAT', 'TVA', 'TW'];

/**
 * Kern-normalisatie: strip niet-alfanum + uppercase + strip BTW-prefix.
 * @param {string} raw
 * @returns {string}
 */
function stripAndUpper(raw) {
  if (raw == null) return '';
  // 1. Verwijder alle niet-alfanum (spaties, punten, streepjes, /, etc).
  let s = String(raw).replace(/[^A-Za-z0-9]/g, '');
  // 2. Uppercase.
  s = s.toUpperCase();
  // 3. Strip eventueel BTW/VAT/TVA-voorvoegsel dat vóór de landcode staat.
  for (const p of STRIP_PREFIXES) {
    if (s.startsWith(p)) {
      s = s.slice(p.length);
      // Loop niet — één prefix strippen is genoeg. Meerdere prefixes achter
      // elkaar ("BTWBTWBE...") is geen legitieme input.
      break;
    }
  }
  return s;
}

/**
 * Leidt landcode af als de input er geen heeft.
 *   - 10 cijfers beginnend met 0 → BE (België)
 *   - 9 cijfers + B + 2 cijfers  → NL
 * Andere patronen → null (niet af te leiden).
 *
 * @param {string} normalized  Output van stripAndUpper (dus geen prefixes/whitespace)
 * @returns {'BE'|'NL'|null}
 */
function inferCountryCode(normalized) {
  if (!normalized) return null;
  // Belgisch patroon: exact 10 cijfers, begint met 0.
  if (/^0\d{9}$/.test(normalized)) return 'BE';
  // Nederlands patroon: 9 cijfers + B + 2 cijfers.
  if (/^\d{9}B\d{2}$/.test(normalized)) return 'NL';
  return null;
}

/**
 * Valideer een genormaliseerd nummer tegen het patroon van zijn landcode.
 * @param {string} normalized
 * @returns {boolean}
 */
function isValidFormat(normalized) {
  if (!normalized) return false;
  const cc = normalized.slice(0, 2);
  const pattern = LAND_PATTERNS[cc];
  if (!pattern) return false;
  return pattern.test(normalized);
}

/**
 * Publieke API: normaliseer + valideer een btw-nummer.
 *
 * @param {string} raw  User-input, bv. "BE 0729.599.851" of "0808.734.629"
 * @returns {{ok:true, normalized:string, country:'BE'|'NL', changed:boolean}
 *        | {ok:false, code:string, error:string, raw?:string, normalized?:string}}
 *
 * ok=false codes:
 *   - VAT_EMPTY               — input leeg / null / whitespace
 *   - VAT_COUNTRY_UNDETECTABLE — geen landcode én niet af te leiden
 *   - VAT_INVALID_FORMAT       — landcode aanwezig maar patroon klopt niet
 *
 * `changed: true` betekent: output verschilt van input. Callers gebruiken dit
 * om te beslissen of ze customers.vat_number moeten bijwerken.
 */
export function normalizeVat(raw) {
  const original = String(raw || '').trim();
  if (!original) {
    return { ok: false, code: 'VAT_EMPTY', error: 'Geen BTW-nummer opgegeven.' };
  }
  let normalized = stripAndUpper(original);
  if (!normalized) {
    return { ok: false, code: 'VAT_EMPTY', error: 'BTW-nummer bevat alleen leestekens.' };
  }
  // Check of er al een landcode voorop staat. Twee gevallen:
  //   (a) voorop = 2 letters + digit-achtige rest: landcode is aanwezig.
  //       - Als de code in LAND_PATTERNS staat → laat 'em zo, format-check volgt.
  //       - Als NIET ondersteund (bv. DE, FR) → VAT_INVALID_FORMAT met leesbare boodschap.
  //   (b) geen landcode → probeer af te leiden. Faalt dat → VAT_COUNTRY_UNDETECTABLE.
  const startsWithLetterPair = /^[A-Z]{2}\d/.test(normalized);
  if (startsWithLetterPair) {
    const cc = normalized.slice(0, 2);
    if (!LAND_PATTERNS[cc]) {
      return {
        ok: false,
        code: 'VAT_INVALID_FORMAT',
        error: `BTW-nummer "${original}" heeft landcode "${cc}" die niet ondersteund is (alleen BE en NL). Als dit een geldig ${cc}-nummer is, verwerk het handmatig.`,
        raw: original,
        normalized,
      };
    }
    // Landcode is BE of NL — format-check gebeurt hieronder.
  } else {
    const inferred = inferCountryCode(normalized);
    if (!inferred) {
      return {
        ok: false,
        code: 'VAT_COUNTRY_UNDETECTABLE',
        error: `BTW-nummer "${original}" heeft geen landcode en het patroon is niet herkenbaar (verwacht: BE + 10 cijfers, of NL + 9 cijfers + B + 2 cijfers). Voeg de landcode toe (BE of NL) en probeer opnieuw.`,
        raw: original,
        normalized,
      };
    }
    normalized = inferred + normalized;
  }
  if (!isValidFormat(normalized)) {
    return {
      ok: false,
      code: 'VAT_INVALID_FORMAT',
      error: `BTW-nummer "${original}" heeft niet het juiste formaat na normalisatie (${normalized}). Verwacht: BE + 10 cijfers, of NL + 9 cijfers + B + 2 cijfers.`,
      raw: original,
      normalized,
    };
  }
  return {
    ok: true,
    normalized,
    country: normalized.slice(0, 2),
    changed: normalized !== original,
  };
}

// Test-exports.
export const _internals = { stripAndUpper, inferCountryCode, isValidFormat, LAND_PATTERNS, STRIP_PREFIXES };
