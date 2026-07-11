// api/_lib/incasso-dossier.js
//
// Kern-helper: createDossierCore(customerId, { country, bureauId, openedBy,
// source, notes }) → { dossier, created:boolean, snapshot:{total_open_eur,
// open_invoice_count} }.
//
// Idempotent: als er al een OPEN dossier voor deze klant bestaat (status
// NIET in de terminal-set) → return { dossier: <bestaand>, created:false }.
// Anders: debt_snapshot uit open invoices, insert dossier (status
// 'aangemeld', opened_by), setStage(customer, 'incasso', ...) fail-soft.
//
// Wordt gebruikt door zowel het handmatige /api/incasso-dossier-create
// endpoint als de nieuwe cron/handmatige-run (/api/cron-incasso-auto en
// /api/incasso-auto-run). Gedrag = identiek: dezelfde snapshot-shape,
// dezelfde pipeline-hook, dezelfde 'aangemeld'-startstatus.

import { supabaseAdmin } from '../supabase.js';

const OPEN_STATUSES     = ['open', 'partially_paid', 'overdue'];
const TERMINAL_STATUSES = ['betaald', 'afgeschreven', 'oninbaar', 'geretourneerd'];

function openAmountEur(inv) {
  const t = Number(inv?.amount_total)    || 0;
  const p = Number(inv?.amount_paid)     || 0;
  const c = Number(inv?.credited_amount) || 0;
  return Math.max(0, t - p - c);
}

export async function createDossierCore(customerId, opts = {}) {
  const country  = (opts.country === 'BE') ? 'BE' : 'NL';
  const bureauId = opts.bureauId || null;
  const openedBy = opts.openedBy || null;
  const source   = opts.source || 'handmatig'; // 'auto' | 'handmatig'
  const notes    = typeof opts.notes === 'string' ? opts.notes : null;

  if (!customerId) throw new Error('customerId verplicht');

  // 1) Idempotency-check: bestaand OPEN dossier? Return dat.
  const { data: existingRows } = await supabaseAdmin
    .from('dunning_incasso_dossiers')
    .select('id, customer_id, bureau_id, country, status, debt_snapshot, notes, opened_at, updated_at')
    .eq('customer_id', customerId)
    .not('status', 'in', `(${TERMINAL_STATUSES.map((s) => `"${s}"`).join(',')})`)
    .order('opened_at', { ascending: false }).limit(1);
  if (existingRows && existingRows.length > 0) {
    return { dossier: existingRows[0], created: false, snapshot: null };
  }

  // 2) debt_snapshot bouwen uit open invoices.
  const { data: invs } = await supabaseAdmin
    .from('invoices')
    .select('id, invoice_number, amount_total, amount_paid, credited_amount, due_date, issue_date, status')
    .eq('customer_id', customerId).in('status', OPEN_STATUSES);
  const openInvs = (invs || []).filter((iv) => openAmountEur(iv) > 0);
  let totalEur = 0;
  const invoiceRows = openInvs.map((iv) => {
    const openEur = openAmountEur(iv);
    totalEur += openEur;
    return {
      id            : iv.id,
      invoice_number: iv.invoice_number || null,
      amount_open   : Math.round(openEur * 100) / 100,
      due_date      : iv.due_date || null,
    };
  });
  const snapshot = {
    snapshot_at         : new Date().toISOString(),
    total_open_eur      : Math.round(totalEur * 100) / 100,
    total_open_cents    : Math.round(totalEur * 100),
    open_invoice_count  : invoiceRows.length,
    invoice_ids         : invoiceRows.map((r) => r.id),
    invoices            : invoiceRows,
    source              : source,
  };

  // 3) Dossier insert.
  const { data: dossier, error: dErr } = await supabaseAdmin
    .from('dunning_incasso_dossiers').insert({
      customer_id  : customerId,
      bureau_id    : bureauId,
      country      : country,
      status       : 'aangemeld',
      debt_snapshot: snapshot,
      notes        : notes,
      opened_by    : openedBy,
    }).select('id, customer_id, bureau_id, country, status, debt_snapshot, notes, opened_by, opened_at, updated_at').single();
  if (dErr) throw new Error('dossier insert: ' + dErr.message);

  // 4) Pipeline-fase → 'incasso'. Fail-soft: dossier moet slagen ook zonder pipeline-move.
  try {
    const { ensurePipelineCustomer, setStage } = await import('./dunning-pipeline.js');
    await ensurePipelineCustomer(customerId);
    await setStage(customerId, 'incasso', 'incasso_dossier_created', 'incasso:' + source, {});
  } catch (e) {
    console.warn('[incasso-dossier-core] pipeline hook soft-fail', e?.message || e);
  }

  return { dossier, created: true, snapshot };
}
