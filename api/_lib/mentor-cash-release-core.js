// api/_lib/mentor-cash-release-core.js
//
// Gedeelde vrijval-motor voor handmatige trajecten. Gebruikt door:
//   - api/cron-mentor-cash-release.js (dagelijkse cron, 0 6 * * *)
//   - api/mentor-cash-traject-release.js (admin testknop, geen secret)
//
// Per actief traject: bepaal de volgende termijn (distincte termijn-
// indices uit idempotency-keys), check of z'n vrijval-datum bereikt is
// (asOfDate >= releaseDate), verdeel het termijnbedrag over de aanwezige
// event-mentoren (event_mentors.was_present=true met user_id), en schrijf
// per mentor een ledger-entry met idempotency_key
//   'cashtraject:<id>:term:<n>:mentor:<uid>'
//
// KRITIEK: per run maximaal ÉÉN termijn per traject. Zo lopen achterstallige
// termijnen netjes 1-per-dag in, en veroorzaakt een gemiste cron-dag geen
// piekvrijval van meerdere termijnen tegelijk.

import { supabaseAdmin } from '../supabase.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

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

// asOfDate → YYYY-MM-DD (UTC-truncatie zonder tz-shift).
function ymd(dateLike) {
  if (!dateLike) return new Date().toISOString().slice(0, 10);
  if (typeof dateLike === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateLike)) return dateLike.slice(0, 10);
  const d = new Date(dateLike);
  return d.toISOString().slice(0, 10);
}

/**
 * Draai de vrijval voor alle actieve trajects (of één specifiek traject).
 *
 * @param {Object} opts
 * @param {string} [opts.trajectId] - Alleen dit traject verwerken (admin-knop).
 * @param {Date|string} [opts.asOfDate] - Referentiedatum voor de dag-check (default: nu).
 * @returns {Promise<Object>} summary { processed, released_count, mentor_entries_count,
 *   completed_count, skipped_no_mentors, skipped_not_due, warnings }
 */
export async function releaseCashTrajectTerms(opts = {}) {
  const { trajectId = null, asOfDate = null } = opts;
  const nowIso = new Date().toISOString();
  const asOfYmd = ymd(asOfDate);
  const summary = {
    processed: 0,
    released_count: 0,          // distincte termijnen deze run
    mentor_entries_count: 0,    // totaal aantal mentor-inserts
    completed_count: 0,
    skipped_no_mentors: 0,
    skipped_not_due: 0,
    warnings: [],
  };

  let q = supabaseAdmin.from('mentor_cash_trajects')
    .select('id, event_id, customer_id, client_label, term_count, bonus_total, pct, start_month, release_day')
    .eq('status', 'active');
  if (trajectId) q = q.eq('id', trajectId);
  const { data: trajects, error: tErr } = await q;
  if (tErr) throw new Error('trajects fetch: ' + tErr.message);

  for (const t of (trajects || [])) {
    summary.processed += 1;
    try {
      // Bestaande keys voor dit traject.
      const idemPrefix = `cashtraject:${t.id}:term:`;
      const { data: existing, error: eErr } = await supabaseAdmin
        .from('mentor_ledger_entries')
        .select('idempotency_key')
        .like('idempotency_key', `${idemPrefix}%`);
      if (eErr) throw new Error('existing entries: ' + eErr.message);

      const doneTermIdx = distinctTermIndices((existing || []).map(e => e.idempotency_key));
      const releasedTerms = doneTermIdx.size;

      // Alle termijnen al vrijgegeven → completed.
      if (releasedTerms >= t.term_count) {
        const { error: cErr } = await supabaseAdmin
          .from('mentor_cash_trajects')
          .update({ status: 'completed' })
          .eq('id', t.id);
        if (cErr) throw new Error('mark completed: ' + cErr.message);
        summary.completed_count += 1;
        continue;
      }

      // Volgende termijn + vrijval-datum-check.
      const termIdx = releasedTerms + 1;
      const relDay  = Number(t.release_day) >= 1 ? Number(t.release_day) : 1;
      const dueDate = releaseDate(t.start_month, termIdx, relDay);
      if (!dueDate) {
        summary.warnings.push(`traject ${t.id}: ongeldige start_month/release_day — skip`);
        continue;
      }
      if (asOfYmd < dueDate) {
        summary.skipped_not_due += 1;
        continue;
      }

      // Aanwezige event-mentoren met user_id.
      const { data: mentorsAll, error: mErr } = await supabaseAdmin
        .from('event_mentors')
        .select(`team_member_id, was_present,
                 team_members:team_member_id ( id, user_id )`)
        .eq('event_id', t.event_id);
      if (mErr) throw new Error('event_mentors: ' + mErr.message);
      const eligibleMentors = (mentorsAll || [])
        .filter(m => m.was_present === true)
        .map(m => ({ team_member_id: m.team_member_id, user_id: m.team_members?.user_id || null }))
        .filter(m => !!m.user_id);
      const N = eligibleMentors.length;
      if (N === 0) {
        summary.skipped_no_mentors += 1;
        summary.warnings.push(`traject ${t.id}: geen aanwezige event-mentoren — termijn niet vrijgegeven`);
        continue;
      }

      // Termijnbedrag + verdeling (identiek aan pre-refactor cron).
      const isLast  = termIdx === t.term_count;
      const perTerm = round2(Number(t.bonus_total) / Number(t.term_count));
      const termAmount = isLast
        ? round2(Number(t.bonus_total) - perTerm * (Number(t.term_count) - 1))
        : perTerm;
      if (termAmount <= 0) {
        summary.warnings.push(`traject ${t.id} term ${termIdx}: berekend bedrag ≤ 0 — skip`);
        continue;
      }
      const perMentor = round2(termAmount / N);
      let entriesThisTerm = 0;
      for (let i = 0; i < N; i++) {
        const isLastM = i === N - 1;
        const amount  = isLastM
          ? round2(termAmount - perMentor * (N - 1))
          : perMentor;
        if (amount <= 0) continue;
        const m = eligibleMentors[i];
        const basis = Number(t.pct) > 0 ? round2(amount * 100 / Number(t.pct)) : 0;
        const idem  = `${idemPrefix}${termIdx}:mentor:${m.user_id}`;
        const { error: insErr } = await supabaseAdmin
          .from('mentor_ledger_entries')
          .insert({
            mentor_user_id : m.user_id,
            team_member_id : m.team_member_id,
            event_id       : t.event_id,
            customer_id    : t.customer_id || null,
            entry_type     : 'bonus',
            basis          : basis,
            basis_incl_btw : true,
            pct            : t.pct,
            amount         : amount,
            status         : 'vrijgegeven',
            // Geplande termijn-datum i.p.v. moment-van-vrijgeven, zodat de
            // termijn-bonus in het payout-rapport valt van de maand waarin
            // 'ie hoort (payout selecteert op released_at).
            released_at    : dueDate,
            source_quote_id  : null,
            source_invoice_id: null,
            idempotency_key: idem,
            note           : `Handmatig traject: ${t.client_label} — termijn ${termIdx}/${t.term_count} / ${N} mentor(en)`,
          });
        if (insErr) {
          if (insErr.code === '23505' || /duplicate key/i.test(insErr.message || '')) {
            continue; // parallel-run / eerder verwerkt
          }
          throw new Error(`ledger insert (mentor ${m.user_id}): ${insErr.message}`);
        }
        summary.mentor_entries_count += 1;
        entriesThisTerm += 1;
      }
      if (entriesThisTerm > 0) summary.released_count += 1;

      // Laatste termijn + entriesThisTerm > 0 → completed.
      if (isLast) {
        const totalNowDone = releasedTerms + (entriesThisTerm > 0 ? 1 : 0);
        if (totalNowDone >= t.term_count) {
          const { error: cErr } = await supabaseAdmin
            .from('mentor_cash_trajects')
            .update({ status: 'completed' })
            .eq('id', t.id);
          if (cErr) throw new Error('mark completed after last: ' + cErr.message);
          summary.completed_count += 1;
        }
      }
    } catch (e) {
      console.error('[mentor-cash-release-core] traject', t.id, e.message);
      summary.warnings.push(`traject ${t.id}: ${e.message}`);
    }
  }

  return summary;
}
