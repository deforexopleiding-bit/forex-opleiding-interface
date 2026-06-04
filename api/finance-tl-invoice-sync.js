// api/finance-tl-invoice-sync.js
// POST → read-only spiegel van Teamleader-facturen (≥ 2026-01-01) naar `invoices`.
// SUPER_ADMIN ONLY. Idempotent (SELECT → UPDATE/INSERT op tl_invoice_id).
// GEEN writes naar Teamleader. Geen overdue-opslag (dynamisch afgeleid in GET/UI).
//
// Body/query: { dry_run=true, department_id?, limit=120, cursor? }
//   - dry_run  : tel + log sample-shape + skipped_details, schrijf NIETS.
//   - cursor   : { di, page } — resumable i.v.m. 60s Vercel-limit. Herhaal tot done=true.
//   - limit    : max facturen per run (checkpoint).
//
// Mapping (geverifieerd tegen echte invoices.list-response, dry-run PR #81):
//   tl_invoice_id      ← id
//   tl_department_id   ← department.id
//   tl_subscription_id ← subscription?.id
//   invoice_number     ← invoice_number ("2026 / 1080"); draft zonder nr → CONCEPT-<id>
//   issue_date         ← invoice_date     due_date ← due_on     paid_date ← paid_at
//   amount_total       ← total.tax_inclusive.amount
//   vat_amount         ← total.tax_inclusive.amount − total.tax_exclusive.amount
//   amount_paid        ← total.payable.amount − total.due.amount   (TL heeft GEEN betaald-veld)
//   status             ← draft→concept · paid===true→paid · outstanding due<payable→partially_paid
//                        · due===payable→open · credit→credited · (overdue = dynamisch)
//
// Customer-match: invoicee.customer.id (type contact) → customers.tl_contact_id.
// Geen match = log + skip (invoices.customer_id is NOT NULL).

import { verifyAdmin, supabaseAdmin } from './supabase.js';
import { tlFetch, getActiveToken } from './_lib/teamleader-token.js';
import { getClientIp } from './_lib/audit-customer.js';

const SYNC_FROM = '2026-01-01';

// company_entities seed (Online/Fysiek/Retentie). Bij department_id-param: alleen die.
const DEPARTMENTS = [
  '09d67371-6947-03f6-bd5e-410dd8636344', // Online
  '0da396bf-1074-0425-ac5c-fa1141b41cb1', // Fysiek
  '9adca043-0ebc-09da-a45e-f21798841cb2', // Retentie
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function tlCall(path, body, attempt = 0) {
  await sleep(200);
  const r = await tlFetch(path, { method: 'POST', body: JSON.stringify(body) });
  if (r.status === 429 && attempt < 3) { await sleep(2000 * Math.pow(2, attempt)); return tlCall(path, body, attempt + 1); }
  return r;
}

// --- Veld-extractie op de echte TL invoices.list-shape ----------------------
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
function amount(obj) {
  if (obj == null) return null;
  if (typeof obj === 'number') return Number.isFinite(obj) ? obj : null;
  if (typeof obj === 'object') { const n = Number(obj.amount); return Number.isFinite(n) ? n : null; }
  const n = Number(obj); return Number.isFinite(n) ? n : null;
}
function isoDate(v) { if (!v) return null; const s = String(v); return s.length >= 10 ? s.slice(0, 10) : null; }

// TL-status + payable/due → onze enum (overdue NIET; dynamisch in GET/UI).
function mapStatus(inv, payable, due) {
  const s = String(inv.status || '').toLowerCase();
  if (s === 'draft') return 'concept';
  if (s.includes('credit')) return 'credited';      // defensief; zeldzaam
  if (inv.paid === true) return 'paid';
  if (due != null && payable != null) {
    if (due <= 0 && payable > 0) return 'paid';
    if (due > 0 && due < payable) return 'partially_paid';
    if (due >= payable) return 'open';
  }
  return 'open';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin only' });
  if (admin.profile.role !== 'super_admin') return res.status(403).json({ error: 'Alleen super_admin mag synchroniseren' });

  const body = req.body || {};
  const dry_run = body.dry_run !== false; // default true
  const department_id = body.department_id || null;
  const maxPerRun = Math.min(Number(body.limit) || 120, 500);
  const cursor = body.cursor && typeof body.cursor === 'object' ? body.cursor : { di: 0, page: 1 };

  const tok = await getActiveToken();
  if (!tok) return res.status(400).json({ error: 'Geen actief Teamleader-token' });

  const depts = department_id ? [department_id] : DEPARTMENTS;
  const totals = { processed: 0, inserted: 0, updated: 0, skipped_no_customer: 0, skipped_old: 0, errors: 0 };
  const skipped_details = [];
  let sampleShape = null;

  // Skip-detail-regel (hoofddoel deze ronde: wie zijn de no-customer-skips?).
  const pushSkip = (inv, incl) => {
    if (skipped_details.length >= 300) return;
    skipped_details.push({
      invoice_number: (inv.invoice_number && String(inv.invoice_number).trim()) || `CONCEPT-${inv.id}`,
      amount: r2(incl),
      status: inv.status || null,
      invoicee_name: inv.invoicee?.name || null,
      tl_contact_id: inv.invoicee?.customer?.id ?? null,
      invoicee_type: inv.invoicee?.customer?.type ?? '(geen customer-object — mogelijk company/B2B)',
    });
  };

  try {
    let di = Math.max(0, Number(cursor.di) || 0);
    let page = Math.max(1, Number(cursor.page) || 1);

    while (di < depts.length) {
      const dept = depts[di];
      const filter = { department_id: dept, invoice_date_after: SYNC_FROM };
      const r = await tlCall('/invoices.list', { filter, page: { size: 100, number: page }, sort: [{ field: 'invoice_date', order: 'desc' }] });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        console.error('[finance-invoice-sync] invoices.list HTTP', r.status, txt.slice(0, 300));
        return res.status(502).json({ error: `TL invoices.list HTTP ${r.status}: ${txt.slice(0, 200)}`, totals, cursor: { di, page } });
      }
      const data = await r.json();
      const batch = data.data || [];

      if (!sampleShape && batch.length) { sampleShape = batch[0]; console.log('[finance-invoice-sync] sample invoice shape', JSON.stringify(batch[0])); }

      for (const inv of batch) {
        totals.processed++;
        try {
          const t = inv.total || {};
          const incl = amount(t.tax_inclusive) ?? amount(t.payable) ?? 0;
          const excl = amount(t.tax_exclusive);
          const payable = amount(t.payable);
          const due = amount(t.due);
          const vat = (incl != null && excl != null) ? r2(incl - excl) : null;
          const paid = (payable != null && due != null) ? Math.max(0, r2(payable - due)) : (inv.paid === true ? r2(incl) : 0);
          const status = mapStatus(inv, payable, due);

          const issue = isoDate(inv.invoice_date) || isoDate(inv.booked_on);
          if (issue && issue < SYNC_FROM) { totals.skipped_old++; continue; }

          // Contact → customer (verplicht; invoices.customer_id NOT NULL).
          const contactId = inv.invoicee?.customer?.id || null;
          if (!contactId) { totals.skipped_no_customer++; pushSkip(inv, incl); continue; }
          const { data: cust } = await supabaseAdmin.from('customers').select('id').eq('tl_contact_id', contactId).maybeSingle();
          if (!cust) { totals.skipped_no_customer++; pushSkip(inv, incl); continue; }

          const rawNumber = (inv.invoice_number && String(inv.invoice_number).trim()) || null;
          const row = {
            customer_id: cust.id,
            tl_invoice_id: inv.id,
            tl_department_id: inv.department?.id || dept,
            tl_subscription_id: inv.subscription?.id ?? null,
            invoice_number: rawNumber || `CONCEPT-${inv.id}`,
            amount_total: r2(incl),
            amount_paid: paid,
            vat_amount: vat,
            issue_date: issue || new Date().toISOString().slice(0, 10),
            due_date: isoDate(inv.due_on) || null,
            paid_date: isoDate(inv.paid_at) || (status === 'paid' ? (isoDate(inv.updated_at) || null) : null),
            status,
            is_manual: false,
            pushed_to_tl: false,
            is_historical: false,
            updated_at: new Date().toISOString(),
          };

          // Idempotent: SELECT → UPDATE/INSERT op tl_invoice_id (geen ON CONFLICT;
          // partial unique index kan geen arbiter zijn — lesson 20 mei).
          const { data: existing } = await supabaseAdmin.from('invoices').select('id').eq('tl_invoice_id', inv.id).maybeSingle();
          if (existing) {
            if (!dry_run) { const { error } = await supabaseAdmin.from('invoices').update(row).eq('id', existing.id); if (error) throw new Error('update: ' + error.message); }
            totals.updated++;
          } else {
            if (!dry_run) { const { error } = await supabaseAdmin.from('invoices').insert(row); if (error) throw new Error('insert: ' + error.message); }
            totals.inserted++;
          }
        } catch (e) {
          totals.errors++;
          if (totals.errors <= 5) console.error('[finance-invoice-sync] factuur', inv?.id, e.message);
        }
      }

      if (batch.length < 100) { di++; page = 1; } else { page++; }

      if (totals.processed >= maxPerRun && di < depts.length) {
        return res.status(200).json({
          done: false, dry_run, totals,
          next_cursor: { di, page },
          sample_shape: dry_run ? sampleShape : undefined,
          skipped_details,
        });
      }
    }

    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id: admin.user.id,
        action: dry_run ? 'finance_invoice_sync.dry_run' : 'finance_invoice_sync.run',
        entity_type: 'invoice', entity_id: null,
        after_json: { totals, dry_run, department_id, sync_from: SYNC_FROM },
        reason_text: `Finance invoice-sync (${dry_run ? 'dry-run' : 'live'}): ${totals.inserted} nieuw, ${totals.updated} bijgewerkt, ${totals.skipped_no_customer} zonder klant, ${totals.errors} errors`,
        ip_address: getClientIp(req),
      });
    } catch (e) { console.error('[finance-invoice-sync] audit:', e.message); }

    return res.status(200).json({
      done: true, dry_run, totals,
      sample_shape: dry_run ? sampleShape : undefined,
      skipped_details,
    });
  } catch (e) {
    console.error('[finance-invoice-sync]', e.message);
    return res.status(500).json({ error: e.message, totals });
  }
}
