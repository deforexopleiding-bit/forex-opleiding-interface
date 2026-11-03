// api/_lib/mentor-cash-release-core.js
//
// Vrijgave voor handmatige trajecten. Gebruikt door:
//   - api/cron-mentor-cash-release.js (dagelijkse cron, 0 6 * * *)
//   - api/mentor-cash-traject-release.js (admin testknop, geen secret)
//
// TOT 3 NOV 2026 gaf deze motor elke maand een termijn vrij op DATUM, zonder
// factuurcheck (bron van de te hoge vrijgave bij de drie trajecten). Dat pad
// is weg: zie releaseCashTrajectTerms hieronder en
// api/_lib/cash-traject-omzetten.js. releaseDate/distinctTermIndices blijven
// voor de weergave van oude termijnregels.

import { supabaseAdmin } from '../supabase.js';
import { releaseProportionalForPaidAmount } from './mentor-ledger-engine.js';

// Distincte termijn-indices uit idempotency-keys ('cashtraject:<id>:term:<n>:mentor:<uid>').
export function distinctTermIndices(keys) {
  const idx = new Set();
  for (const k of keys) {
    const m = /:term:(\d+)(?:$|:)/.exec(String(k || ''));
    if (m) idx.add(Number(m[1]));
  }
  return idx;
}

// Vrijval-datum voor termijn N. UTC-veilig, kale datum (YYYY-MM-DD).
//   base  = start_month + (N-1) maanden
//   day   = min(release_day, laatste dag van die maand)
// release_day 31 in feb → 28/29 feb.
export function releaseDate(startMonthIso, termIdx, releaseDay) {
  const s = String(startMonthIso || '');
  const m = /^(\d{4})-(\d{2})/.exec(s);
  if (!m) return null;
  const y0 = Number(m[1]);
  const mo0 = Number(m[2]) - 1;               // 0-based
  const totalMonths = mo0 + (termIdx - 1);    // add N-1 maanden
  const y = y0 + Math.floor(totalMonths / 12);
  const mo = ((totalMonths % 12) + 12) % 12;
  // Laatste dag van (y, mo): dag 0 van (y, mo+1) = laatste dag mo.
  const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  const day = Math.min(Number(releaseDay) || 1, lastDay);
  const dt = new Date(Date.UTC(y, mo, day));
  return dt.toISOString().slice(0, 10);
}

/**
 * Vrijgave voor trajectklanten — ALTIJD via de factuurmotor.
 *
 * Sinds 3 nov 2026 (beslissing Maxim): enkel een betaalde factuur geeft
 * commissie vrij. Deze functie schrijft ZELF GEEN grootboekregels meer en
 * kijkt niet meer naar de kalender. Per traject:
 *   - status 'omgezet' + customer_id → releaseProportionalForPaidAmount voor
 *     die klant (doel = commissie × betaald / basis; reeds vrijgegeven telt
 *     mee, dus te veel vrijgegeven wordt verrekend);
 *   - anders (actief/gepauzeerd zonder klant of sale): NIETS, met een
 *     waarschuwing. Zonder factuurcheck geen vrijgave.
 *
 * @param {Object} opts
 * @param {string} [opts.trajectId] - Alleen dit traject (admin-knop).
 * @param {boolean} [opts.dryRun]   - Berekenen zonder te schrijven.
 * @returns {Promise<Object>} summary { processed, released_count, mentor_entries_count,
 *   completed_count, skipped_no_mentors, skipped_not_due, skipped_zonder_factuurcheck,
 *   klanten: [...], warnings }
 */
export async function releaseCashTrajectTerms(opts = {}) {
  const { trajectId = null, dryRun = false } = opts;
  const summary = {
    processed: 0,
    released_count: 0,          // klanten waarvoor de factuurmotor iets vrijgaf
    mentor_entries_count: 0,    // aantal child-regels geschreven door de factuurmotor
    completed_count: 0,         // blijft 0: een traject wordt niet meer op datum "voltooid"
    skipped_no_mentors: 0,
    skipped_not_due: 0,
    skipped_zonder_factuurcheck: 0,
    klanten: [],
    warnings: [],
  };

  let q = supabaseAdmin.from('mentor_cash_trajects')
    .select('id, customer_id, client_label, status')
    .in('status', ['active', 'paused', 'omgezet']);
  if (trajectId) q = q.eq('id', trajectId);
  const { data: trajects, error: tErr } = await q;
  if (tErr) throw new Error('trajects fetch: ' + tErr.message);

  const gedaan = new Set();
  for (const t of (trajects || [])) {
    summary.processed += 1;
    if (t.status !== 'omgezet' || !t.customer_id) {
      summary.skipped_zonder_factuurcheck += 1;
      if (t.status !== 'paused') {
        summary.warnings.push(`traject ${t.id} (${t.client_label || '-'}): nog niet omgezet naar de factuurmotor — geen vrijgave zonder factuurcheck`);
      }
      continue;
    }
    if (gedaan.has(t.customer_id)) continue;
    gedaan.add(t.customer_id);
    try {
      const r = await releaseProportionalForPaidAmount({ customerId: t.customer_id, dryRun });
      const n = dryRun ? (r.simulations || []).filter((s) => s.would_release).length : (r.released_children || 0);
      summary.mentor_entries_count += n;
      if (n > 0) summary.released_count += 1;
      summary.klanten.push({ traject_id: t.id, customer_id: t.customer_id, client_label: t.client_label, total_released: r.total_released || 0, simulations: r.simulations || [] });
    } catch (e) {
      console.error('[mentor-cash-release-core] traject', t.id, e.message);
      summary.warnings.push(`traject ${t.id}: ${e.message}`);
    }
  }
  return summary;
}
