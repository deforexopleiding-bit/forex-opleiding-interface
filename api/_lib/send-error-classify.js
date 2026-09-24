// api/_lib/send-error-classify.js
//
// Helpers voor de afspraak-berichtenflow (cron-afspraak-reminders):
//   - classifySendError(): permanent (ontvanger bestaat niet) vs tijdelijk.
//   - backoff-constanten voor de bevestiging-retry (cap + exponentieel).
//   - detectEmailTypo(): herkent typefouten in het domein bij import.
//
// Bewust NIET elke 5xx als permanent: 535 (auth) en 5.7.x (policy/relay) zijn
// problemen aan ONZE kant. Die als "adres onbezorgbaar" markeren zou bij één
// SMTP-configfout de mail naar álle afspraken stilleggen. Alleen ontvanger-
// specifieke signalen zijn permanent; de rest valt onder cap + backoff.

export const MAX_ATTEMPTS = 7;
// Wachttijd NA mislukte poging n (1-based). Na poging 7 volgt give-up, dus de
// laatste waarde is het plafond en wordt in de praktijk niet gebruikt.
export const BACKOFF_MIN = [3, 6, 12, 24, 48, 96, 192];

export function backoffMinNaPoging(n) {
  const i = Math.min(Math.max(1, n), BACKOFF_MIN.length) - 1;
  return BACKOFF_MIN[i];
}

// Ontvanger-specifieke permanente SMTP-fouten.
const PERMANENT_ENHANCED = /\b5\.1\.\d{1,2}\b|\b5\.2\.1\b/;               // bad mailbox / bad domain / syntax / null-MX / disabled
const PERMANENT_TEXT = /domain does not exist|domain not found|no such domain|user unknown|unknown user|no such user|mailbox unavailable|mailbox not found|mailbox does not exist|recipient address rejected|address rejected|does not exist|invalid recipient|recipient not found|no mx record|host not found/i;
// Aan onze kant (auth, policy, relay, spam-block): nooit het adres markeren.
const OWN_SIDE = /\b535\b|\b5\.7\.\d{1,2}\b|authentication|auth failed|relay (access )?denied|not permitted to relay|spam|blocked|policy/i;
const OWN_SIDE_CODES = new Set(['UNKNOWN_MAILBOX', 'SMTP_NOT_CONFIGURED', 'TRANSPORT_INIT', 'NO_SUBJECT', 'NO_TEXT']);

/**
 * @param {{kanaal:'mail'|'email'|'whatsapp', reason?:string, code?:string}} o
 * @returns {{ soort:'permanent'|'tijdelijk', reden:string }}
 */
export function classifySendError({ kanaal, reason = '', code = '' } = {}) {
  const reden = String(reason || code || 'onbekend').slice(0, 500);
  // WhatsApp: geen "telefoon onbezorgbaar"-marker → altijd via cap + backoff.
  if (kanaal === 'whatsapp') return { soort: 'tijdelijk', reden };
  if (OWN_SIDE_CODES.has(String(code || ''))) return { soort: 'tijdelijk', reden };
  const tekst = String(reason || '');
  if (OWN_SIDE.test(tekst) && !PERMANENT_ENHANCED.test(tekst)) return { soort: 'tijdelijk', reden };
  if (PERMANENT_ENHANCED.test(tekst) || PERMANENT_TEXT.test(tekst)) return { soort: 'permanent', reden };
  return { soort: 'tijdelijk', reden };
}

// ── Domein-typefouten ──────────────────────────────────────────────────────
// Conservatief: alleen evidente fouten. Geldige ccTLD's als .co / .cm worden
// NIET als TLD-fout gezien (bestaan echt); wél bekende providers met een
// verkeerde naam of TLD.
const TLD_TYPO = { col: 'com', con: 'com', cmo: 'com', comm: 'com', coom: 'com', cpm: 'com', vom: 'com', xom: 'com', ocm: 'com', clm: 'com', nll: 'nl' };
const PROVIDER_TYPO = {
  gmial: 'gmail', gmai: 'gmail', gmal: 'gmail', gnail: 'gmail', gmaill: 'gmail', gamil: 'gmail', gmali: 'gmail', gmsil: 'gmail',
  hotmal: 'hotmail', hotmial: 'hotmail', hotmai: 'hotmail', hotamil: 'hotmail', homail: 'hotmail', hotmaill: 'hotmail', hotnail: 'hotmail',
  outlok: 'outlook', outloo: 'outlook', outlool: 'outlook', outllok: 'outlook',
  yaho: 'yahoo', yahooo: 'yahoo', iclould: 'icloud', iclod: 'icloud', icoud: 'icloud',
};
// Providers die alleen op .com bestaan voor consumenten-adressen.
const ALLEEN_COM = new Set(['gmail', 'icloud']);

/**
 * @param {string|null} email
 * @returns {null | { domein:string, suggestie:string, reden:string }}
 */
export function detectEmailTypo(email) {
  const s = String(email || '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at < 1 || at === s.length - 1) return null;
  const domein = s.slice(at + 1);
  const delen = domein.split('.');
  if (delen.length < 2) return null;
  const tld = delen[delen.length - 1];
  const naam = delen[delen.length - 2];
  let nieuweNaam = PROVIDER_TYPO[naam] || naam;
  let nieuweTld = TLD_TYPO[tld] || tld;
  if (ALLEEN_COM.has(nieuweNaam) && delen.length === 2 && nieuweTld !== 'com') nieuweTld = 'com';
  if (nieuweNaam === naam && nieuweTld === tld) return null;
  const suggestieDomein = [...delen.slice(0, -2), nieuweNaam, nieuweTld].join('.');
  return {
    domein,
    suggestie: s.slice(0, at + 1) + suggestieDomein,
    reden: `typefout-domein: ${domein} (bedoeld: ${suggestieDomein}?)`,
  };
}
