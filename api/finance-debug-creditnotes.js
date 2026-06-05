// api/finance-debug-creditnotes.js
// ⚠️ TIJDELIJK / DEBUG — VERWIJDEREN VÓÓR DE SYNC-MERGE.
// GET [?samples=3] — super_admin only. Read-only verkenning van TL creditNotes:
//   1. creditNotes.list per department (credit_note_date_after 2026-01-01) → totaal aantal (impact);
//   2. creditNotes.info op N voorbeelden → structuur + koppelveld naar de originele factuur;
//   3. per voorbeeld: bedrag + gekoppeld factuurnummer + status bij ons nu.
// Geen DB-mutatie.

import { verifyAdmin, supabaseAdmin } from './supabase.js';
import { tlFetch } from './_lib/teamleader-token.js';

const SYNC_FROM = '2026-01-01';
const DEPARTMENTS = [
  { id: '09d67371-6947-03f6-bd5e-410dd8636344', label: 'Online' },
  { id: '0da396bf-1074-0425-ac5c-fa1141b41cb1', label: 'Fysiek' },
  { id: '9adca043-0ebc-09da-a45e-f21798841cb2', label: 'Retentie' },
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function tlCall(path, body, attempt = 0) {
  await sleep(200);
  const r = await tlFetch(path, { method: 'POST', body: JSON.stringify(body) });
  if (r.status === 429 && attempt < 3) { await sleep(2000 * Math.pow(2, attempt)); return tlCall(path, body, attempt + 1); }
  return r;
}
function amt(o) {
  if (o == null) return null;
  if (typeof o === 'number') return Number.isFinite(o) ? o : null;
  if (typeof o === 'object') { const n = Number(o.amount); return Number.isFinite(n) ? n : null; }
  const n = Number(o); return Number.isFinite(n) ? n : null;
}
// Defensief: vind de referentie naar de originele factuur (veldnaam onbekend in de spec).
function findInvoiceRef(cn) {
  if (!cn || typeof cn !== 'object') return { id: null, field: null };
  const direct = [['invoice', cn.invoice], ['invoiced_document', cn.invoiced_document], ['original_invoice', cn.original_invoice], ['invoice_id', cn.invoice_id]];
  for (const [field, v] of direct) {
    if (v && typeof v === 'object' && v.id) return { id: v.id, field };
    if (typeof v === 'string' && v) return { id: v, field };
  }
  for (const [k, v] of Object.entries(cn)) {
    if (!/invoice/i.test(k)) continue;
    if (v && typeof v === 'object' && v.id) return { id: v.id, field: k };
    if (typeof v === 'string' && v) return { id: v, field: k };
  }
  return { id: null, field: null };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin only' });
  if (admin.profile.role !== 'super_admin') return res.status(403).json({ error: 'Alleen super_admin' });

  const sampleCount = Math.min(Math.max(Number(req.query?.samples) || 3, 1), 10);

  try {
    // 1. Tellen per department.
    const per_department = [];
    const all = [];
    let listErrors = [];
    for (const dept of DEPARTMENTS) {
      let deptCount = 0;
      for (let page = 1; ; page++) {
        const r = await tlCall('/creditNotes.list', { filter: { department_id: dept.id, credit_note_date_after: SYNC_FROM }, page: { size: 100, number: page }, sort: [{ field: 'credit_note_date', order: 'desc' }] });
        if (!r.ok) { const t = await r.text().catch(() => ''); listErrors.push({ dept: dept.label, status: r.status, body: t.slice(0, 300) }); break; }
        const data = await r.json();
        const batch = data.data || [];
        deptCount += batch.length;
        for (const cn of batch) all.push({ id: cn.id, dept: dept.label });
        if (batch.length < 100) break;
      }
      per_department.push({ department: dept.label, count: deptCount });
    }
    const total = all.length;

    // 2+3. Detail op N voorbeelden.
    const samples = [];
    for (const ref of all.slice(0, sampleCount)) {
      try {
        const r = await tlCall('/creditNotes.info', { id: ref.id });
        if (!r.ok) { samples.push({ id: ref.id, error: `info HTTP ${r.status}` }); continue; }
        const cn = (await r.json()).data || {};
        const invRef = findInvoiceRef(cn);

        // Onze factuur opzoeken via tl_invoice_id.
        let our_invoice = null;
        if (invRef.id) {
          const { data: row } = await supabaseAdmin.from('invoices')
            .select('invoice_number, status, amount_total, amount_paid, tl_invoice_id').eq('tl_invoice_id', invRef.id).maybeSingle();
          our_invoice = row || null;
        }

        samples.push({
          credit_note_id: cn.id,
          number: cn.invoice_number || cn.number || cn.credit_note_number || null,
          status: cn.status || null,
          credit_note_date: cn.credit_note_date || cn.date || cn.booked_on || null,
          department: cn.department?.id || ref.dept,
          total_tax_inclusive: amt(cn.total?.tax_inclusive),
          total_tax_exclusive: amt(cn.total?.tax_exclusive),
          invoice_ref_field: invRef.field,   // <-- ontdekte koppelveld-naam
          invoice_ref_id: invRef.id,
          our_invoice,                        // factuurnr + onze huidige status (paid/partially_paid?)
          raw: cn,
        });
      } catch (e) { samples.push({ id: ref.id, error: e.message }); }
    }

    return res.status(200).json({
      sync_from: SYNC_FROM,
      total_credit_notes: total,
      per_department,
      list_errors: listErrors.length ? listErrors : undefined,
      samples,
    });
  } catch (e) {
    console.error('[finance-debug-creditnotes]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
