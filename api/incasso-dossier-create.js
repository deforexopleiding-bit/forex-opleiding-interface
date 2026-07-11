// api/incasso-dossier-create.js
// POST { customer_id, bureau_id?, country? }
//   Bouwt debt_snapshot uit open invoices, insert dossier (status='aangemeld'),
//   zet pipeline-fase op 'incasso' (fail-soft).
//   Guard: al open dossier voor deze klant → 409.
// Permission: finance.incasso.manage.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_STATUSES     = ['open', 'partially_paid', 'overdue'];
const TERMINAL_STATUSES = ['betaald', 'afgeschreven', 'oninbaar', 'geretourneerd'];

function openAmountEur(inv) {
  const t = Number(inv?.amount_total)    || 0;
  const p = Number(inv?.amount_paid)     || 0;
  const c = Number(inv?.credited_amount) || 0;
  return Math.max(0, t - p - c);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.incasso.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.incasso.manage)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const customerId = typeof body.customer_id === 'string' && UUID_RE.test(body.customer_id) ? body.customer_id : null;
  const bureauId   = typeof body.bureau_id   === 'string' && UUID_RE.test(body.bureau_id)   ? body.bureau_id   : null;
  const country    = (body.country === 'BE') ? 'BE' : 'NL';
  const notes      = typeof body.notes === 'string' ? body.notes.trim() : null;
  // PR-3: bewust doorgaan zonder pre-incassobrief bij particulier.
  const confirmNoBrief = body.confirm_no_brief === true;

  if (!customerId) return res.status(400).json({ error: 'customer_id (uuid) verplicht' });

  try {
    // 1) Guard: bestaand open dossier?
    const { data: existing } = await supabaseAdmin
      .from('dunning_incasso_dossiers').select('id, status')
      .eq('customer_id', customerId)
      .not('status', 'in', `(${TERMINAL_STATUSES.map((s) => `"${s}"`).join(',')})`)
      .limit(1);
    if (existing && existing.length > 0) {
      return res.status(409).json({ error: 'Klant zit al in incasso (open dossier)', dossier_id: existing[0].id });
    }

    // 2) Customer bestaat?
    const { data: customer, error: cErr } = await supabaseAdmin
      .from('customers').select('id, first_name, last_name, company_name, is_company, email, phone')
      .eq('id', customerId).maybeSingle();
    if (cErr) throw new Error('customers lookup: ' + cErr.message);
    if (!customer) return res.status(404).json({ error: 'Klant niet gevonden' });

    // 2b) PR-3 particulier-guard: pre-incassobrief (WIK NL / eerste
    // herinnering BE) verplicht vóór incasso, tenzij expliciet
    // confirm_no_brief=true. Zakelijke klanten (is_company=true) zijn
    // vrijgesteld. Marker: dunning_log event 'incasso_pre_brief_sent'
    // voor deze klant. Geen brief én geen bevestiging → 200 met
    // { needs_brief:true } (NIET een dossier aanmaken).
    const isPrivate = customer.is_company !== true;
    if (isPrivate && !confirmNoBrief) {
      let hasBriefSent = false;
      try {
        const { data: sentRows } = await supabaseAdmin
          .from('dunning_log').select('id')
          .eq('event_type', 'incasso_pre_brief_sent')
          .filter('payload->>customer_id', 'eq', customerId).limit(1);
        hasBriefSent = Array.isArray(sentRows) && sentRows.length > 0;
      } catch (e) {
        console.warn('[incasso-dossier-create] pre-brief lookup soft-fail', e?.message || e);
      }
      if (!hasBriefSent) {
        return res.status(200).json({
          needs_brief: true,
          country,
          customer_id: customerId,
          message: 'Verplichte pre-incassobrief nog niet verstuurd — verstuur eerst de WIK/BE-brief of bevestig doorgaan zonder brief.',
        });
      }
    }

    // 3) debt_snapshot bouwen — open invoices op moment van aanmelden.
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
    const debtSnapshot = {
      snapshot_at         : new Date().toISOString(),
      total_open_eur      : Math.round(totalEur * 100) / 100,
      total_open_cents    : Math.round(totalEur * 100),
      open_invoice_count  : invoiceRows.length,
      invoice_ids         : invoiceRows.map((r) => r.id),
      invoices            : invoiceRows,
    };

    // 4) Dossier insert.
    const { data: dossier, error: dErr } = await supabaseAdmin
      .from('dunning_incasso_dossiers').insert({
        customer_id  : customerId,
        bureau_id    : bureauId,
        country      : country,
        status       : 'aangemeld',
        debt_snapshot: debtSnapshot,
        notes        : notes,
        opened_by    : user.id,
      }).select('id, customer_id, bureau_id, country, status, debt_snapshot, notes, opened_by, opened_at, updated_at').single();
    if (dErr) throw new Error('dossier insert: ' + dErr.message);

    // 5) Pipeline-fase → 'incasso'. Fail-soft: dossier moet slagen ook zonder pipeline-move.
    try {
      const { ensurePipelineCustomer, setStage } = await import('./_lib/dunning-pipeline.js');
      await ensurePipelineCustomer(customerId);
      await setStage(customerId, 'incasso', 'incasso_dossier_created', 'user:' + user.id, {});
    } catch (e) {
      console.warn('[incasso-dossier-create] pipeline hook soft-fail', e?.message || e);
    }

    return res.status(200).json({ ok: true, dossier });
  } catch (e) {
    console.error('[incasso-dossier-create]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
