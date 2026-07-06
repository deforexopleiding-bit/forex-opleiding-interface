// api/cron-mentor-cash-release.js
//
// Maandelijkse cron: laat per actief mentor_cash_traject de eerstvolgende
// termijn-bonus vrijvallen (mentor_ledger_entries insert). Draait 1× per
// maand (vercel.json: "0 6 1 * *" — 1e van de maand 06:00).
//
// Idempotency: per (traject, termijn-nummer) een unieke
// idempotency_key 'cashtraject:<traject_id>:term:<n>'. Dubbele cron-run
// laat de tweede insert stilletjes vallen (23505). VOORWAARDE voor volgende
// termijn: aantal reeds bestaande ledger-entries voor dit traject
// (getellt via idempotency_key LIKE 'cashtraject:<id>:term:%') < term_count
// EN status = 'active'. Zo schuift een 'paused' periode de resterende
// termijnen naar achteren zonder complexe datumrekening.
//
// Elke termijn krijgt status='vrijgegeven' (direct meetellend in payout-run
// en bonus-overview — geen factuurcheck bij contante trajects).
//
// Auth: Authorization: Bearer $CRON_SECRET (zelfde patroon als andere crons).
// Return: { processed, released_count, completed_count, warnings } — geen PII.

import { checkCronAuth, supabaseAdmin } from './supabase.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const nowIso = new Date().toISOString();
  const summary = { processed: 0, released_count: 0, completed_count: 0, warnings: [] };

  try {
    // 1. Alle actieve trajects.
    const { data: trajects, error: tErr } = await supabaseAdmin
      .from('mentor_cash_trajects')
      .select('id, mentor_user_id, event_id, customer_id, client_label, term_count, bonus_total, pct')
      .eq('status', 'active');
    if (tErr) throw new Error('trajects fetch: ' + tErr.message);

    for (const t of (trajects || [])) {
      summary.processed += 1;
      try {
        // 2. Reeds vrijgegeven termijnen voor dit traject via idempotency_key-prefix.
        //    (Geen basis-kolom filter — de key is de canonical marker.)
        const idemPrefix = `cashtraject:${t.id}:term:`;
        const { data: existing, error: eErr } = await supabaseAdmin
          .from('mentor_ledger_entries')
          .select('idempotency_key')
          .like('idempotency_key', `${idemPrefix}%`);
        if (eErr) throw new Error('existing entries: ' + eErr.message);
        const releasedCount = Array.isArray(existing) ? existing.length : 0;

        // 3. Alle termijnen al vrijgegeven → markeer completed en skip.
        if (releasedCount >= t.term_count) {
          const { error: cErr } = await supabaseAdmin
            .from('mentor_cash_trajects')
            .update({ status: 'completed' })
            .eq('id', t.id);
          if (cErr) throw new Error('mark completed: ' + cErr.message);
          summary.completed_count += 1;
          continue;
        }

        // 4. Volgende termijnnummer (1-based).
        const termIdx  = releasedCount + 1;
        const isLast   = termIdx === t.term_count;
        const perTerm  = round2(Number(t.bonus_total) / Number(t.term_count));
        // Laatste termijn compenseert afrondingsverschil zodat som == bonus_total.
        const amount   = isLast
          ? round2(Number(t.bonus_total) - perTerm * (Number(t.term_count) - 1))
          : perTerm;

        if (amount <= 0) {
          summary.warnings.push(`traject ${t.id}: berekend bedrag ≤ 0 — skip`);
          continue;
        }

        const idem = `${idemPrefix}${termIdx}`;
        const basisPerTerm = round2(Number(t.pct) > 0
          ? (amount * 100 / Number(t.pct))
          : 0);

        const { error: insErr } = await supabaseAdmin
          .from('mentor_ledger_entries')
          .insert({
            mentor_user_id : t.mentor_user_id,
            event_id       : t.event_id,
            customer_id    : t.customer_id || null,
            entry_type     : 'bonus',
            basis          : basisPerTerm,
            basis_incl_btw : true,
            pct            : t.pct,
            amount         : amount,
            status         : 'vrijgegeven',           // direct meetellend
            released_at    : nowIso,
            source_quote_id  : null,
            source_invoice_id: null,
            idempotency_key: idem,
            note           : `Contant traject: ${t.client_label} — termijn ${termIdx}/${t.term_count}`,
          });
        if (insErr) {
          if (insErr.code === '23505' || /duplicate key/i.test(insErr.message || '')) {
            // Al aangemaakt in parallel-run / vorige poging → prima.
            continue;
          }
          throw new Error('ledger insert: ' + insErr.message);
        }
        summary.released_count += 1;

        // 5. Was dit de laatste termijn? → traject completed.
        if (isLast) {
          const { error: cErr } = await supabaseAdmin
            .from('mentor_cash_trajects')
            .update({ status: 'completed' })
            .eq('id', t.id);
          if (cErr) throw new Error('mark completed after last: ' + cErr.message);
          summary.completed_count += 1;
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
