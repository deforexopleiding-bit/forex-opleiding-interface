// api/cron-mentor-cash-release.js
//
// Maandelijkse cron: verdeelt per actief handmatig traject de eerstvolgende
// termijn-bonus over de AANWEZIGE mentoren van het event (event_mentors.
// was_present=true → team_members.user_id). Elke mentor krijgt een aparte
// ledger-entry. Draait 1× per maand (vercel.json: "0 6 1 * *").
//
// Event-gedreven sinds 2026-07-06-cash-trajects-event-driven.sql: geen
// vaste mentor op de traject-rij; verdeling gebeurt hier.
//
// Idempotency:
//   idempotency_key = 'cashtraject:<traject_id>:term:<termIdx>:mentor:<user_id>'
// Per (traject, termijn, mentor) uniek → herhaalde runs slaan duplicate-
// inserts stilletjes over (23505).
//
// Volgende termijn-telling: DISTINCTE termijn-indices uit de bestaande keys
// (parse ':term:<n>:mentor:' segment). NIET op ruwe entry-count — bij
// meerdere mentoren per termijn zou dat te ver springen.
//
// Bij N=0 aanwezige mentoren (met user_id): traject wordt overgeslagen met
// warning; termijn wordt NIET vrijgegeven, traject NIET completed. Als de
// mentoren later alsnog gekoppeld zijn (en aanwezig gezet), pakt de volgende
// cron-run alsnog termijn 1.
//
// Auth: Authorization: Bearer $CRON_SECRET.
// Return: { processed, released_count, mentor_entries_count, completed_count,
//           skipped_no_mentors, warnings } — geen PII.

import { checkCronAuth, supabaseAdmin } from './supabase.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Haal distincte termijn-indices uit een set idempotency-keys.
// Key-vormen die we accepteren:
//   'cashtraject:<uuid>:term:<n>:mentor:<uuid>'  (nieuw, event-driven)
//   'cashtraject:<uuid>:term:<n>'                (legacy, één-mentor — hier
//                                                 nooit meer geschreven, maar
//                                                 defensief tellen we 'm mee
//                                                 voor het geval een oude
//                                                 rij bestaat.)
function distinctTermIndices(keys) {
  const idx = new Set();
  for (const k of keys) {
    const m = /:term:(\d+)(?:$|:)/.exec(String(k || ''));
    if (m) idx.add(Number(m[1]));
  }
  return idx;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const nowIso = new Date().toISOString();
  const summary = {
    processed: 0,
    released_count: 0,          // distincte termijnen vrijgegeven deze run
    mentor_entries_count: 0,    // totaal aantal ledger-inserts (over mentoren)
    completed_count: 0,
    skipped_no_mentors: 0,
    warnings: [],
  };

  try {
    // 1. Alle actieve trajects.
    const { data: trajects, error: tErr } = await supabaseAdmin
      .from('mentor_cash_trajects')
      .select('id, event_id, customer_id, client_label, term_count, bonus_total, pct')
      .eq('status', 'active');
    if (tErr) throw new Error('trajects fetch: ' + tErr.message);

    for (const t of (trajects || [])) {
      summary.processed += 1;
      try {
        // 2. Bestaande keys voor dit traject.
        const idemPrefix = `cashtraject:${t.id}:term:`;
        const { data: existing, error: eErr } = await supabaseAdmin
          .from('mentor_ledger_entries')
          .select('idempotency_key')
          .like('idempotency_key', `${idemPrefix}%`);
        if (eErr) throw new Error('existing entries: ' + eErr.message);

        // 3. Distincte termijnen tellen (niet ruwe entry-count).
        const doneTermIdx = distinctTermIndices((existing || []).map(e => e.idempotency_key));
        const releasedTerms = doneTermIdx.size;

        // 4. Alle termijnen al vrijgegeven → completed en skip.
        if (releasedTerms >= t.term_count) {
          const { error: cErr } = await supabaseAdmin
            .from('mentor_cash_trajects')
            .update({ status: 'completed' })
            .eq('id', t.id);
          if (cErr) throw new Error('mark completed: ' + cErr.message);
          summary.completed_count += 1;
          continue;
        }

        // 5. Aanwezige event-mentoren met user_id — zelfde query-shape als
        //    events-complete-core.js sectie 6.
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

        // 6. Volgende termijnnummer + termijnbedrag met remainder-correctie.
        const termIdx = releasedTerms + 1;
        const isLast  = termIdx === t.term_count;
        const perTerm = round2(Number(t.bonus_total) / Number(t.term_count));
        const termAmount = isLast
          ? round2(Number(t.bonus_total) - perTerm * (Number(t.term_count) - 1))
          : perTerm;
        if (termAmount <= 0) {
          summary.warnings.push(`traject ${t.id} term ${termIdx}: berekend bedrag ≤ 0 — skip`);
          continue;
        }

        // 7. Verdeel termAmount over N mentoren; laatste mentor krijgt de
        //    afrondingscompensatie zodat som === termAmount.
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
              released_at    : nowIso,
              source_quote_id  : null,
              source_invoice_id: null,
              idempotency_key: idem,
              note           : `Handmatig traject: ${t.client_label} — termijn ${termIdx}/${t.term_count} / ${N} mentor(en)`,
            });
          if (insErr) {
            if (insErr.code === '23505' || /duplicate key/i.test(insErr.message || '')) {
              // Al aangemaakt in vorige run / parallel-run → prima.
              continue;
            }
            throw new Error(`ledger insert (mentor ${m.user_id}): ${insErr.message}`);
          }
          summary.mentor_entries_count += 1;
          entriesThisTerm += 1;
        }
        if (entriesThisTerm > 0) summary.released_count += 1;

        // 8. Was dit de laatste termijn? → traject completed.
        //    Alleen als daadwerkelijk vrijgegeven (bv. alle mentor-inserts
        //    kunnen 23505 hebben — dan is de termijn al vrijgegeven in een
        //    eerdere run). We markeren dan alsnog completed als de distincte-
        //    termijn-telling na deze run gelijk zou zijn aan term_count.
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
        console.error('[cron-mentor-cash-release] traject', t.id, e.message);
        summary.warnings.push(`traject ${t.id}: ${e.message}`);
      }
    }

    return res.status(200).json(summary);
  } catch (e) {
    console.error('[cron-mentor-cash-release]', e.message);
    return res.status(500).json({ error: e.message, ...summary });
  }
}
