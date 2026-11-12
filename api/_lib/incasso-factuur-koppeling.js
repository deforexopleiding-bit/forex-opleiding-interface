// api/_lib/incasso-factuur-koppeling.js
//
// SYNC-KANT van de koppeling factuur → incasso-regelingsabonnement (12 nov
// 2026, Maxim). Teamleader geeft sinds augustus 2026 geen abonnement-id meer
// mee op een factuur (invoices.tl_subscription_id blijft NULL). Zonder die
// koppeling stond bij Noorulhaq november op "nog geen factuur" terwijl
// factuur 2026/2317 er was, en kon "Betaling ontvangen" niet.
//
// Regel = koppelRegelingFacturen() in incasso-maandlijst.js (klant + periode +
// bedrag, enkel eenduidig). Bewust BEPERKT tot abonnementen van soort
// incasso_regeling: een koppeling verandert ook welke sale een factuur telt
// voor commissie en bonus; voor gewone abonnementen beslist Maxim dat apart.
//
// Fail-soft: een fout hier geeft null (niet koppelen) en breekt de sync nooit.

import { koppelRegelingFacturen } from './incasso-maandlijst.js';
import { soortKolomOntbreekt } from './subscription-soort.js';

const TTL_MS = 60 * 1000;
let cache = { t: 0, perKlant: null };

/** Alleen voor tests. */
export function _resetKoppelCache() { cache = { t: 0, perKlant: null }; }

/** customer_id → incasso_regeling-abonnementen (60 s cache per proces). */
async function regelingSubsPerKlant(db) {
  if (cache.perKlant && Date.now() - cache.t < TTL_MS) return cache.perKlant;
  const perKlant = new Map();
  const { data: subs, error } = await db.from('subscriptions')
    .select('id, deal_id, amount, vat_percentage, line_items, term_count, start_date, billing_cycle, status, teamleader_subscription_id, soort')
    .eq('soort', 'incasso_regeling');
  if (error) {
    if (soortKolomOntbreekt(error)) { cache = { t: Date.now(), perKlant }; return perKlant; }
    throw new Error('subscriptions: ' + error.message);
  }
  const dealIds = [...new Set((subs || []).map((s) => s.deal_id).filter(Boolean))];
  if (dealIds.length) {
    const { data: deals, error: dErr } = await db.from('deals').select('id, customer_id').in('id', dealIds);
    if (dErr) throw new Error('deals: ' + dErr.message);
    const klantVan = new Map((deals || []).map((d) => [d.id, d.customer_id]));
    for (const s of subs || []) {
      const c = klantVan.get(s.deal_id);
      if (!c) continue;
      if (!perKlant.has(c)) perKlant.set(c, []);
      perKlant.get(c).push(s);
    }
  }
  cache = { t: Date.now(), perKlant };
  return perKlant;
}

/**
 * Bij welk incasso-regelingsabonnement hoort deze factuur (zonder
 * abonnement-id van Teamleader)? Kijkt naar ALLE facturen van de klant, zodat
 * de sync, de maandlijst en de backfill hetzelfde beslissen.
 *
 * @param {object} db supabase-client (service role)
 * @param {{ customerId: string, factuur: object }} p factuur met id (of null bij
 *   een nieuwe), amount_total, credited_amount, status, issue_date, due_date
 * @returns {Promise<string|null>} teamleader_subscription_id of null
 */
export async function zoekRegelingKoppeling(db, { customerId, factuur }) {
  try {
    if (!customerId || !factuur || factuur.tl_subscription_id) return null;
    const subs = (await regelingSubsPerKlant(db)).get(customerId) || [];
    if (!subs.length) return null;
    const { data: andere, error } = await db.from('invoices')
      .select('id, tl_subscription_id, amount_total, credited_amount, status, issue_date, due_date')
      .eq('customer_id', customerId);
    if (error) throw new Error('invoices: ' + error.message);
    const eigenId = factuur.id || '__nieuw__';
    const lijst = [...(andere || []).filter((f) => f.id !== factuur.id), { ...factuur, id: eigenId }];
    return koppelRegelingFacturen({ facturen: lijst, subs }).get(eigenId) || null;
  } catch (e) {
    console.warn('[incasso-factuur-koppeling] niet gekoppeld (fail-soft):', e?.message || e);
    return null;
  }
}
