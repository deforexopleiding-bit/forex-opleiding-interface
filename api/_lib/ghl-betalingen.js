// api/_lib/ghl-betalingen.js
//
// BETAALD VIA GOHIGHLEVEL per klant (voor het incasso-overzicht, 3 nov 2026).
// Alleen lezen: GET /payments/transactions (altType=location, contactId).
// Vereist de PIT-scope `payments/transactions.readonly`. Ontbreekt die (401/403)
// of faalt GHL, dan is het antwoord `null` met een reden — het overzicht toont
// dan "GHL niet gelezen" en rekent enkel met Teamleader. Nooit een gok.
//
// Telt enkel geslaagde betalingen (status succeeded); terugbetaald telt niet,
// deels terugbetaald telt het bedrag min wat terugging.

import fetch from 'node-fetch';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const VERSIE = '2021-07-28';
const TIME_OUT_MS = 6000;

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** Pure: som van de geslaagde transacties. */
export function somGeslaagd(transacties = []) {
  let som = 0;
  for (const t of transacties || []) {
    const st = String(t?.status || '').toLowerCase();
    const bedrag = Number(t?.amount) || 0;
    if (st === 'succeeded') som += bedrag;
    else if (st === 'partially_refunded') som += Math.max(0, bedrag - (Number(t?.amountRefunded ?? t?.refundedAmount) || 0));
  }
  return r2(som);
}

/**
 * @returns {Promise<{ ok: true, bedrag: number, aantal: number } | { ok: false, reden: string }>}
 */
export async function leesGhlBetaald(contactId, { doeFetch = fetch } = {}) {
  if (!contactId) return { ok: false, reden: 'geen_ghl_contact' };
  const token = process.env.GHL_PIT_TOKEN || process.env.GHL_API_KEY;
  const loc = process.env.GHL_LOCATION_ID;
  if (!token || !loc) return { ok: false, reden: 'ghl_niet_ingesteld' };
  const url = `${GHL_BASE}/payments/transactions?altId=${encodeURIComponent(loc)}&altType=location&contactId=${encodeURIComponent(contactId)}&limit=100`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIME_OUT_MS);
    const res = await doeFetch(url, { headers: { Authorization: `Bearer ${token}`, Version: VERSIE, Accept: 'application/json' }, signal: ctrl.signal });
    clearTimeout(t);
    if (res.status === 401 || res.status === 403) return { ok: false, reden: 'ghl_geen_scope' };
    if (!res.ok) return { ok: false, reden: `ghl_http_${res.status}` };
    const body = await res.json().catch(() => null);
    const lijst = Array.isArray(body?.data) ? body.data : Array.isArray(body?.transactions) ? body.transactions : null;
    if (!lijst) return { ok: false, reden: 'ghl_onverwacht_antwoord' };
    return { ok: true, bedrag: somGeslaagd(lijst), aantal: lijst.length };
  } catch (e) {
    console.warn('[ghl-betalingen]', contactId, e?.message || e);
    return { ok: false, reden: 'ghl_onbereikbaar' };
  }
}
