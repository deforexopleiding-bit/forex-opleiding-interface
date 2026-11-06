// api/_lib/betaalmethode.js
//
// Hoe is een factuur betaald? Eén plek voor het label, gebruikt door
// factuurdetail (finance-invoice-payments), de maandlijst incasso-abonnementen
// en het controlescherm mentorcommissie. Puur, geen DB.
//
// payments.payment_method: 'cash' bij een contante betaling (sinds 6 nov 2026,
// finance-invoice-register-cash). Oudere rijen hebben NULL; dan zegt
// payments.source het: 'camt_match' = bankafschrift, 'manual' = handmatig.
// Een factuur die op betaald staat zonder payments-rij kwam uit Teamleader
// (sync) — de methode is ons dan onbekend.

import { betaaldBedrag } from './factuur-betaald.js';

export const CASH = 'cash';

const LABEL = {
  cash: 'Contant',
  bank: 'Bank',
  overschrijving: 'Overschrijving',
  camt_match: 'Bank (afschrift)',
  manual: 'Handmatig geboekt',
  teamleader: 'Teamleader',
};

/** Code van één payments-rij: payment_method, anders de bron. */
export function betaalmethodeCode(p) {
  if (!p) return null;
  const m = String(p.payment_method || '').trim().toLowerCase();
  if (m) return m;
  const s = String(p.source || '').trim().toLowerCase();
  return s || null;
}

export function betaalmethodeLabel(code) {
  if (!code) return null;
  return LABEL[code] || code;
}

export const isCash = (p) => betaalmethodeCode(p) === CASH;

/**
 * Methoden van de betalingen van één factuur, uniek, in volgorde.
 * @param {Array} betalingen payments-rijen ({ payment_method, source, amount })
 * @param {object} [inv]     factuur; betaald zonder rij → 'teamleader'
 * @returns {{ codes: string[], label: string|null, cash: number }}
 *   cash = som van de contante betalingen.
 */
export function betaalmethodenVan(betalingen = [], inv = null) {
  const codes = [];
  let cash = 0;
  for (const p of betalingen || []) {
    if (!(Number(p?.amount) > 0)) continue;
    const c = betaalmethodeCode(p);
    if (c && !codes.includes(c)) codes.push(c);
    if (c === CASH) cash += Number(p.amount) || 0;
  }
  if (!codes.length && inv && betaaldBedrag(inv) > 0) codes.push('teamleader'); // gecrediteerd telt nooit als betaald
  return {
    codes,
    label: codes.length ? codes.map(betaalmethodeLabel).join(' + ') : null,
    cash: Math.round(cash * 100) / 100,
  };
}
