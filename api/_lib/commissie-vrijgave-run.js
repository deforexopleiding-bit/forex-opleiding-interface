// api/_lib/commissie-vrijgave-run.js
//
// De factuurmotor voor een reeks klanten (rekenregel 9 nov 2026). Gebruikt
// door de uurlijkse Teamleader-sync (klanten waarvan een betaling veranderde)
// en de dagelijkse vangnet-cron (alle klanten met open commissie).
//
// WAAROM (9 nov 2026): de motor draaide enkel bij een betaling die in het CRM
// geregistreerd werd, bij de handmatige super_admin-sync en bij een paar
// statuswijzigingen. Facturen die in Teamleader betaald worden (bank →
// Teamleader → uurlijkse sync) raakten de motor NOOIT: daarom gaf hij bij
// BV Ky, Richiano Blondiau en John Rasmussen nooit iets vrij. Dit dicht dat
// gat. Idempotent: een tweede run schrijft niets bij.
//
// Eén overzicht per mentor per run (cache) en een tijdsbudget: wat niet past,
// pakt de volgende run (de motor is idempotent).

import { supabaseAdmin } from '../supabase.js';
import { releaseProportionalForPaidAmount } from './mentor-ledger-engine.js';

/** Klanten met een open commissie (parent pending/wachten_op_betaling). */
export async function klantenMetOpenCommissie(db = supabaseAdmin) {
  const ids = new Set();
  for (let van = 0; ; van += 1000) {
    const { data, error } = await db.from('mentor_ledger_entries').select('customer_id')
      .eq('entry_type', 'bonus').is('parent_entry_id', null).in('status', ['pending', 'wachten_op_betaling'])
      .range(van, van + 999);
    if (error) throw new Error('mentor_ledger_entries: ' + error.message);
    for (const r of data || []) if (r.customer_id) ids.add(r.customer_id);
    if (!data || data.length < 1000) break;
  }
  return [...ids];
}

/**
 * @param {string[]} customerIds
 * @param {object} [o]
 * @param {number} [o.deadline]  Date.now()-waarde waarna niets nieuws meer start
 * @param {boolean} [o.dryRun]
 * @returns {Promise<{ klanten, verwerkt, vrijgegeven, kinderen, fouten, overgeslagen, voorbeelden }>}
 */
export async function vrijgaveVoorKlanten(customerIds, { deadline = Infinity, dryRun = false } = {}) {
  const uniek = [...new Set((customerIds || []).filter(Boolean))];
  const cache = new Map();
  const uit = { klanten: uniek.length, verwerkt: 0, vrijgegeven: 0, kinderen: 0, fouten: 0, overgeslagen: 0, voorbeelden: [] };
  for (const cid of uniek) {
    if (Date.now() > deadline) { uit.overgeslagen += 1; continue; }
    try {
      const r = await releaseProportionalForPaidAmount({ customerId: cid, dryRun, overzichtCache: cache });
      uit.verwerkt += 1;
      uit.vrijgegeven = Math.round((uit.vrijgegeven + (Number(r.total_released) || 0)) * 100) / 100;
      uit.kinderen += Number(r.released_children) || 0;
      if ((Number(r.total_released) || 0) > 0 && uit.voorbeelden.length < 20) uit.voorbeelden.push({ customer_id: cid, vrijgegeven: r.total_released });
      // De cache blijft geldig: de motor schrijft enkel stukken in open
      // maanden, en die veranderen de stukken van het overzicht niet (de motor
      // leest de bestaande kinderen telkens vers).
    } catch (e) {
      uit.fouten += 1;
      if (uit.fouten <= 3) console.error('[commissie-vrijgave]', cid, e?.message || e);
    }
  }
  return uit;
}
