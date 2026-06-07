// api/finance-payment-matcher-run.js
// POST → batched bulk-matcher voor bestaande camt_transactions die nog niet
// matched zijn (of opnieuw matchen bij scope='all'). Loopt over inkomende
// transacties (amount_cents > 0), genereert match-candidates en optioneel
// auto-confirmt bij autopilot.
//
// Body:
//   { scope: 'unmatched' | 'all' }   default 'unmatched'
//
// Permission: finance.bank.transactions_view (read+write op match_candidates
// + side-effect auto-confirm → TL-call wordt verder gegated door eigen
// register-payment permission op internal niveau).
//
// 50s tijdsbudget zoals cron-pattern. Cursor/abort safety: blijft idempotent
// dankzij UNIQUE constraint (camt_tx, invoice) op match_candidates en upsert
// ignoreDuplicates. Bij abort kan je gewoon opnieuw triggeren.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { matchCamtTransaction } from './_lib/payment-matcher.js';
import { registerPaymentInternal } from './_lib/register-payment-internal.js';

const ABORT_MS = 50_000;
const BATCH_SIZE = 50;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.bank.transactions_view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.bank.transactions_view)' });
  }

  const { scope = 'unmatched' } = req.body || {};
  if (!['unmatched', 'all'].includes(scope)) {
    return res.status(400).json({ error: "scope moet 'unmatched' of 'all' zijn" });
  }

  const startedAt = Date.now();

  try {
    // 1. Open invoices met customer-naam (eenmalig fetch, hergebruikt over alle batches).
    const { data: openInvoicesRaw } = await supabaseAdmin
      .from('invoices')
      .select('id, invoice_number, amount_total, amount_paid, status, issue_date, customer_id, customers (first_name, last_name, company_name)')
      .in('status', ['open', 'partially_paid', 'overdue']);
    const invForMatcher = (openInvoicesRaw || []).map(inv => ({
      ...inv,
      customer_name: (inv.customers?.company_name && inv.customers.company_name.trim())
                  || [inv.customers?.first_name, inv.customers?.last_name].filter(Boolean).join(' ').trim()
                  || '',
    }));

    // 2. Autopilot-setting eenmalig lezen.
    const { data: autopilotRow } = await supabaseAdmin
      .from('app_settings').select('value').eq('key', 'payment_match_autopilot').maybeSingle();
    const autopilot = autopilotRow?.value || { enabled: false, threshold: 95 };
    const autoEnabled = autopilot.enabled === true;
    const autoThreshold = Math.max(0, Math.min(100, Number(autopilot.threshold) || 95));

    // 3. Voor scope='unmatched' verzamel eerst alle camt_tx-ids die al een
    //    candidate hebben (één query, paginated). Dat filter wordt vervolgens
    //    op de iteratie toegepast (we kunnen 't niet client-side filteren want
    //    we paginate door camt_transactions zelf).
    const alreadyMatchedIds = new Set();
    if (scope === 'unmatched') {
      const CHUNK = 1000;
      let offset = 0;
      while (true) {
        const { data: chunk } = await supabaseAdmin
          .from('payment_match_candidates')
          .select('camt_transaction_id')
          .range(offset, offset + CHUNK - 1);
        if (!chunk || chunk.length === 0) break;
        for (const r of chunk) if (r.camt_transaction_id) alreadyMatchedIds.add(r.camt_transaction_id);
        if (chunk.length < CHUNK) break;
        offset += CHUNK;
      }
    }

    // 4. Iterateer over camt_transactions in batches op booking_date desc
    //    (recent eerst — die zijn meestal het meest relevant).
    let totals = { processed: 0, candidates_created: 0, auto_confirmed: 0, auto_confirm_failed: 0, errors: 0 };
    let aborted = false;
    let offset = 0;

    while (true) {
      if (Date.now() - startedAt > ABORT_MS) { aborted = true; break; }
      const { data: txs, error: txErr } = await supabaseAdmin
        .from('camt_transactions')
        .select('id, booking_date, amount_cents, description, counterparty_name, end_to_end_id')
        .gt('amount_cents', 0)                          // alleen inkomend
        .order('booking_date', { ascending: false })
        .order('id', { ascending: false })
        .range(offset, offset + BATCH_SIZE - 1);
      if (txErr) {
        console.error('[matcher-run] tx select fout:', txErr.message);
        totals.errors++;
        break;
      }
      if (!txs || txs.length === 0) break;

      const candidateRows = [];
      const txByIdInBatch = new Map();

      for (const tx of txs) {
        if (Date.now() - startedAt > ABORT_MS) { aborted = true; break; }
        if (scope === 'unmatched' && alreadyMatchedIds.has(tx.id)) continue;
        totals.processed++;
        txByIdInBatch.set(tx.id, tx);

        const candidates = matchCamtTransaction(tx, invForMatcher);
        for (const c of candidates) {
          candidateRows.push({
            camt_transaction_id: tx.id,
            invoice_id:          c.invoice_id,
            match_score:         c.score,
            match_reasons:       c.reasons,
            status:              'suggested',
          });
        }
      }

      // Bulk-upsert candidates voor deze batch.
      if (candidateRows.length) {
        const { error: candErr } = await supabaseAdmin
          .from('payment_match_candidates')
          .upsert(candidateRows, { onConflict: 'camt_transaction_id,invoice_id', ignoreDuplicates: true });
        if (candErr) {
          console.error('[matcher-run] candidates upsert fout:', candErr.message);
          totals.errors++;
        } else {
          totals.candidates_created += candidateRows.length;
        }
      }

      // Autopilot-pad per batch: re-fetch net-aangemaakte 'suggested' candidates
      // voor de processed-tx-ids in deze batch, pak hoogste per tx, confirm
      // bij score >= threshold.
      if (autoEnabled && txByIdInBatch.size) {
        const txIds = Array.from(txByIdInBatch.keys());
        const { data: freshCandidates } = await supabaseAdmin
          .from('payment_match_candidates')
          .select('id, camt_transaction_id, invoice_id, match_score')
          .in('camt_transaction_id', txIds)
          .eq('status', 'suggested')
          .order('match_score', { ascending: false });

        const bestPerTx = new Map();
        for (const c of (freshCandidates || [])) {
          if (!bestPerTx.has(c.camt_transaction_id)) bestPerTx.set(c.camt_transaction_id, c);
        }

        for (const [txId, c] of bestPerTx) {
          if (Date.now() - startedAt > ABORT_MS) { aborted = true; break; }
          if (c.match_score < autoThreshold) continue;
          const tx = txByIdInBatch.get(txId);
          if (!tx) continue;
          try {
            const result = await registerPaymentInternal({
              invoiceId:       c.invoice_id,
              amount:          (Number(tx.amount_cents) || 0) / 100,
              paidAt:          String(tx.booking_date).slice(0, 10),
              paymentMethodId: null,
              source:          'camt_match_autopilot',
              userId:          user.id,
              ipAddress:       null,
            });
            await supabaseAdmin
              .from('payment_match_candidates')
              .update({
                status:                'auto_confirmed',
                confirmed_at:          new Date().toISOString(),
                confirmed_by_user_id:  user.id,
                registered_payment_id: result.payment_db_id,
              })
              .eq('id', c.id);
            totals.auto_confirmed++;
          } catch (e) {
            console.warn(`[matcher-run] autopilot confirm faalde match=${c.id}:`, e.message);
            totals.auto_confirm_failed++;
          }
        }
      }

      if (aborted) break;
      if (txs.length < BATCH_SIZE) break;
      offset += BATCH_SIZE;
    }

    const durationMs = Date.now() - startedAt;
    console.log('[matcher-run] klaar', JSON.stringify({ scope, ...totals, duration_ms: durationMs, aborted }));

    return res.status(200).json({
      success: true,
      scope,
      processed:            totals.processed,
      candidates_created:   totals.candidates_created,
      auto_confirmed:       totals.auto_confirmed,
      auto_confirm_failed:  totals.auto_confirm_failed,
      errors:               totals.errors,
      duration_ms:          durationMs,
      aborted_by_timeout:   aborted,
    });
  } catch (e) {
    console.error('[matcher-run]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
