// api/finance-tl-invoice-sync.js
// POST → read-only spiegel van Teamleader-facturen (≥ 2026-01-01) naar `invoices`.
// SUPER_ADMIN ONLY. Idempotent (SELECT → UPDATE/INSERT op tl_invoice_id).
// GEEN writes naar Teamleader. Geen overdue-opslag (dynamisch afgeleid in GET/UI).
//
// Body/query: { dry_run=true, department_id?, limit=120, cursor? }
//   - dry_run  : tel + log sample-shape, schrijf NIETS.
//   - cursor   : { di, page } — resumable i.v.m. 60s Vercel-limit. Herhaal tot done=true.
//   - limit    : max facturen per run (checkpoint).
//
// Throttle 200ms/TL-call + 429 exp-backoff (zoals tl-import-subscriptions.js).
// Customer-match: TL invoicee-contact → customers.tl_contact_id. Geen match =
// log + skip (invoices.customer_id is NOT NULL → kan niet zonder klant).

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

// --- Defensieve veld-extractie (TL invoices.list response-shape varieert) -----
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
// Bedrag uit geneste TL total-objecten of platte velden.
function amount(obj) {
  if (obj == null) return null;
  if (typeof obj === 'number') return obj;
  if (typeof obj === 'object') return num(obj.amount ?? obj.value);
  return num(obj);
}
function inclTotal(inv) {
  const t = inv.total || {};
  return amount(t.tax_inclusive) ?? amount(t.payable) ?? amount(inv.total_price) ?? amount(t.tax_exclusive) ?? amount(inv.total) ?? 0;
}
function exclTotal(inv) {
  const t = inv.total || {};
  return amount(t.tax_exclusive) ?? null;
}
// Reeds betaald bedrag — list geeft soms 'paid' (bool) en/of een outstanding-veld.
function paidAmount(inv, incl) {
  const t = inv.total || {};
  const due = amount(t.due) ?? amount(inv.outstanding);
  if (due != null && incl != null) return Math.max(0, Math.round((incl - due) * 100) / 100);
  const ap = amount(inv.amount_paid) ?? amount(inv.paid_amount);
  if (ap != null) return ap;
  if (inv.paid === true) return incl || 0;
  return 0;
}
function isoDate(v) { if (!v) return null; const s = String(v); return s.length >= 10 ? s.slice(0, 10) : null; }

// TL-status + bedragen → onze enum (overdue NIET; dynamisch in GET/UI).
function mapStatus(tlStatus, incl, paid) {
  const s = String(tlStatus || '').toLowerCase();
  if (s === 'draft') return 'concept';
  if (s.includes('credit')) return 'credited';
  if (s === 'matched' || s === 'paid') return 'paid';
  // outstanding / booked / overige geboekte:
  if (incl != null && paid >= incl && incl > 0) return 'paid';
  if (paid > 0) return 'partially_paid';
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
  let cursor = body.cursor && typeof body.cursor === 'object' ? body.cursor : { di: 0, page: 1 };

  const tok = await getActiveToken();
  if (!tok) return res.status(400).json({ error: 'Geen actief Teamleader-token' });

  const depts = department_id ? [department_id] : DEPARTMENTS;
  const totals = { processed: 0, inserted: 0, updated: 0, skipped_no_customer: 0, skipped_old: 0, errors: 0 };
  const skippedContacts = [];
  let sampleShape = null;
  let done = false;

  try {
    let di = Math.max(0, Number(cursor.di) || 0);
    let page = Math.max(1, Number(cursor.page) || 1);

    while (di < depts.length) {
      const dept = depts[di];
      // Filter facturen ≥ SYNC_FROM. Veldnaam kan per TL-versie verschillen → we
      // sturen invoice_date_after én guarden client-side op issue_date.
      const filter = { department_id: dept, invoice_date_after: SYNC_FROM };
      const r = await tlCall('/invoices.list', { filter, page: { size: 100, number: page }, sort: [{ field: 'invoice_date', order: 'desc' }] });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        console.error('[finance-invoice-sync] invoices.list HTTP', r.status, txt.slice(0, 300));
        return res.status(502).json({ error: `TL invoices.list HTTP ${r.status}: ${txt.slice(0, 200)}`, totals, cursor: { di, page } });
      }
      const data = await r.json();
      const batch = data.data || [];

      // Eénmalig de ruwe shape loggen (verificatie veldnamen tijdens dry-run).
      if (!sampleShape && batch.length) {
        sampleShape = batch[0];
        console.log('[finance-invoice-sync] sample invoice shape', JSON.stringify(batch[0]));
      }

      for (const inv of batch) {
        totals.processed++;
        try {
          const issue = isoDate(inv.invoice_date || inv.date) || isoDate(inv.booked_on);
          // Client-side guard op venster (drafts zonder datum → today-fallback later).
          if (issue && issue < SYNC_FROM) { totals.skipped_old++; continue; }

          const incl = Math.round((inclTotal(inv) || 0) * 100) / 100;
          const excl = exclTotal(inv);
          const paid = paidAmount(inv, incl);
          const vat = excl != null ? Math.round((incl - excl) * 100) / 100 : null;
          const status = mapStatus(inv.status, incl, paid);

          // Contact → customer (verplicht; invoices.customer_id is NOT NULL).
          const contactId = inv.invoicee?.customer?.id || inv.invoicee?.id || inv.customer?.id || null;
          if (!contactId) { totals.skipped_no_customer++; skippedContacts.push({ tl_invoice_id: inv.id, reason: 'geen invoicee-contact' }); continue; }
          const { data: cust } = await supabaseAdmin.from('customers').select('id').eq('tl_contact_id', contactId).maybeSingle();
          if (!cust) { totals.skipped_no_customer++; skippedContacts.push({ tl_invoice_id: inv.id, tl_contact_id: contactId }); continue; }

          // Concept zonder nummer → placeholder (uniek per factuur).
          const rawNumber = (inv.invoice_number && String(inv.invoice_number).trim()) || null;
          const invoiceNumber = rawNumber || `CONCEPT-${inv.id}`;

          const row = {
            customer_id: cust.id,
            tl_invoice_id: inv.id,
            tl_department_id: inv.department?.id || dept,
            invoice_number: invoiceNumber,
            amount_total: incl,
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

          // Idempotent: SELECT → UPDATE/INSERT op tl_invoice_id (geen ON CONFLICT,
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

      // Volgende pagina, of volgende department.
      if (batch.length < 100) { di++; page = 1; } else { page++; }

      // Checkpoint: stop als we de per-run-cap raken (maar dept nog niet leeg).
      if (totals.processed >= maxPerRun && di < depts.length) {
        return res.status(200).json({
          done: false, dry_run, totals,
          next_cursor: { di, page },
          sample_shape: dry_run ? sampleShape : undefined,
          skipped_contacts: skippedContacts.slice(0, 20),
        });
      }
    }
    done = true;

    // Audit (ook dry-run).
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
      done, dry_run, totals,
      sample_shape: dry_run ? sampleShape : undefined,
      skipped_contacts: skippedContacts.slice(0, 50),
    });
  } catch (e) {
    console.error('[finance-invoice-sync]', e.message);
    return res.status(500).json({ error: e.message, totals });
  }
}
