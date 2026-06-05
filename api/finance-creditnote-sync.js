// api/finance-creditnote-sync.js
// POST → spiegel van TL creditnota's (≥ 2026-01-01) naar `credit_notes` + herbereken
// invoices.credited_amount. SUPER_ADMIN ONLY. Idempotent (SELECT→UPDATE/INSERT op
// tl_credit_note_id). Read van TL, geen TL-writes.
//
// Body/query: { dry_run=true, department_id?, limit=60, cursor? }
//   - cursor : { di, page } — resumable (60s Vercel-limit). Herhaal tot done=true.
//   - per creditnota: creditNotes.info → koppel via het `invoice`-object (id = tl_invoice_id)
//     aan onze factuur; upsert; aan het eind credited_amount herberekenen voor geraakte facturen.

import { verifyAdmin, supabaseAdmin } from './supabase.js';
import { tlFetch, getActiveToken } from './_lib/teamleader-token.js';
import { getClientIp } from './_lib/audit-customer.js';

const SYNC_FROM = '2026-01-01';
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
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
function amt(o) {
  if (o == null) return null;
  if (typeof o === 'number') return Number.isFinite(o) ? o : null;
  if (typeof o === 'object') { const n = Number(o.amount); return Number.isFinite(n) ? n : null; }
  const n = Number(o); return Number.isFinite(n) ? n : null;
}
function isoDate(v) { if (!v) return null; const s = String(v); return s.length >= 10 ? s.slice(0, 10) : null; }
// Koppeling naar de originele factuur (TL-veld `invoice` object-ref; defensieve fallback).
function invoiceRefId(cn) {
  if (cn?.invoice?.id) return cn.invoice.id;
  if (typeof cn?.invoice === 'string') return cn.invoice;
  if (cn?.invoiced_document?.id) return cn.invoiced_document.id;
  if (cn?.invoice_id) return cn.invoice_id;
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin only' });
  if (admin.profile.role !== 'super_admin') return res.status(403).json({ error: 'Alleen super_admin mag synchroniseren' });

  const body = req.body || {};
  const dry_run = body.dry_run !== false;
  const department_id = body.department_id || null;
  const maxPerRun = Math.min(Number(body.limit) || 60, 300);
  const cursor = body.cursor && typeof body.cursor === 'object' ? body.cursor : { di: 0, page: 1 };

  const tok = await getActiveToken();
  if (!tok) return res.status(400).json({ error: 'Geen actief Teamleader-token' });

  const depts = department_id ? [department_id] : DEPARTMENTS;
  const totals = { processed: 0, inserted: 0, updated: 0, linked: 0, unlinked: 0, errors: 0 };
  const affected = new Set();
  const samples = [];

  try {
    let di = Math.max(0, Number(cursor.di) || 0);
    let page = Math.max(1, Number(cursor.page) || 1);

    while (di < depts.length) {
      const dept = depts[di];
      const lr = await tlCall('/creditNotes.list', { filter: { department_id: dept, credit_note_date_after: SYNC_FROM }, page: { size: 100, number: page }, sort: [{ field: 'credit_note_date', order: 'desc' }] });
      if (!lr.ok) { const t = await lr.text().catch(() => ''); console.error('[creditnote-sync] list HTTP', lr.status, t.slice(0, 200)); return res.status(502).json({ error: `TL creditNotes.list HTTP ${lr.status}: ${t.slice(0, 200)}`, totals, cursor: { di, page } }); }
      const batch = (await lr.json()).data || [];

      for (const lite of batch) {
        totals.processed++;
        try {
          const ir = await tlCall('/creditNotes.info', { id: lite.id });
          if (!ir.ok) { totals.errors++; if (totals.errors <= 5) console.error('[creditnote-sync] info HTTP', ir.status, lite.id); continue; }
          const cn = (await ir.json()).data || {};
          const tlInvId = invoiceRefId(cn);
          const incl = r2(amt(cn.total?.tax_inclusive) ?? amt(cn.total?.payable) ?? 0);

          // Koppel aan onze factuur via tl_invoice_id.
          let invoiceUuid = null;
          if (tlInvId) {
            const { data: invRow } = await supabaseAdmin.from('invoices').select('id').eq('tl_invoice_id', tlInvId).maybeSingle();
            invoiceUuid = invRow?.id || null;
          }
          if (invoiceUuid) { totals.linked++; affected.add(invoiceUuid); } else totals.unlinked++;

          const row = {
            tl_credit_note_id: cn.id,
            credit_note_number: (cn.invoice_number || cn.number || cn.credit_note_number || null),
            tl_invoice_id: tlInvId,
            invoice_id: invoiceUuid,
            department_id: cn.department?.id || dept,
            amount_total: incl,
            credit_note_date: isoDate(cn.credit_note_date || cn.date || cn.booked_on),
            status: cn.status || null,
            updated_at: new Date().toISOString(),
          };

          if (samples.length < 5) samples.push({ number: row.credit_note_number, amount_total: incl, tl_invoice_id: tlInvId, linked: !!invoiceUuid, status: row.status, date: row.credit_note_date });

          const { data: existing } = await supabaseAdmin.from('credit_notes').select('id').eq('tl_credit_note_id', cn.id).maybeSingle();
          if (existing) { if (!dry_run) { const { error } = await supabaseAdmin.from('credit_notes').update(row).eq('id', existing.id); if (error) throw new Error('update: ' + error.message); } totals.updated++; }
          else { if (!dry_run) { const { error } = await supabaseAdmin.from('credit_notes').insert(row); if (error) throw new Error('insert: ' + error.message); } totals.inserted++; }
        } catch (e) { totals.errors++; if (totals.errors <= 5) console.error('[creditnote-sync] cn', lite?.id, e.message); }
      }

      if (batch.length < 100) { di++; page = 1; } else { page++; }

      if (totals.processed >= maxPerRun && di < depts.length) {
        if (!dry_run) await recompute(affected);
        return res.status(200).json({ done: false, dry_run, totals, next_cursor: { di, page }, affected_invoices: affected.size, samples });
      }
    }

    if (!dry_run) await recompute(affected);

    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id: admin.user.id, action: dry_run ? 'finance_creditnote_sync.dry_run' : 'finance_creditnote_sync.run',
        entity_type: 'credit_note', entity_id: null, after_json: { totals, dry_run, affected_invoices: affected.size },
        reason_text: `Creditnota-sync (${dry_run ? 'dry-run' : 'live'}): ${totals.inserted} nieuw, ${totals.updated} bijgewerkt, ${totals.linked} gekoppeld, ${totals.unlinked} zonder factuur`,
        ip_address: getClientIp(req),
      });
    } catch (e) { console.error('[creditnote-sync] audit', e.message); }

    return res.status(200).json({ done: true, dry_run, totals, affected_invoices: affected.size, samples });
  } catch (e) {
    console.error('[creditnote-sync]', e.message);
    return res.status(500).json({ error: e.message, totals });
  }
}

// Herbereken invoices.credited_amount = som van gekoppelde credit_notes (incl. btw).
async function recompute(affectedSet) {
  for (const invoiceId of affectedSet) {
    try {
      const { data: rows } = await supabaseAdmin.from('credit_notes').select('amount_total').eq('invoice_id', invoiceId);
      const sum = Math.round((rows || []).reduce((a, r) => a + (Number(r.amount_total) || 0), 0) * 100) / 100;
      await supabaseAdmin.from('invoices').update({ credited_amount: sum, updated_at: new Date().toISOString() }).eq('id', invoiceId);
    } catch (e) { console.error('[creditnote-sync] recompute', invoiceId, e.message); }
  }
}
