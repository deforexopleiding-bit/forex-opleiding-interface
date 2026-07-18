// api/_lib/phone-normalize.js
//
// Pure helpers voor telefoon-normalisatie. Gedeeld door de globale follow-up
// zoekbalk (api/follow-up-search.js) en potentieel later ook door andere
// endpoints die telefoon-fuzzy-matches doen.
//
// Pattern uit CLAUDE.md lesson 18 (Fase E1.1 inbox-webhook): strip alle
// non-digits + `slice(-9)` fallback voor de lokale variant zonder landcode.
// NL: 06-12345678 vs +31612345678 → dezelfde laatste 9 digits.
// BE: 0470-123456 vs +32470123456 → idem.

/**
 * Strip alles behalve digits. Retourneert een lege string bij null/undefined.
 * @param {string|null|undefined} raw
 * @returns {string}
 */
export function stripToDigits(raw) {
  return String(raw || '').replace(/\D/g, '');
}

/**
 * Laatste 9 digits van een telefoonnummer — praktische lokale-variant-key
 * voor NL/BE. Retourneert null als er geen 9+ digits inzitten (te kort om
 * betrouwbaar te matchen).
 *
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
export function last9Digits(raw) {
  const d = stripToDigits(raw);
  return d.length >= 9 ? d.slice(-9) : null;
}

/**
 * Twee telefoonnummers als "waarschijnlijk zelfde persoon"-vergelijking.
 * True bij één van:
 *   - beide leeg (voorzichtige false: we willen geen ruis-matches op leeg)
 *   - digit-strings identiek
 *   - last9 identiek (beide hebben >=9 digits)
 * False anders.
 *
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {boolean}
 */
export function phonesLikelyMatch(a, b) {
  const da = stripToDigits(a);
  const db = stripToDigits(b);
  if (!da || !db) return false;
  if (da === db) return true;
  const la = last9Digits(a);
  const lb = last9Digits(b);
  return !!(la && lb && la === lb);
}
