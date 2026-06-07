// api/finance-invoice-tl-inspect.js
// DIAGNOSE-ONLY endpoint. Returnt de volledige TL invoices.info-response voor
// een opgegeven tl_invoice_id of invoice_number, plus een schaduw-uitvoering
// van onze mapping-logica zodat we direct zien wat de cron WEL of NIET
// gemapped zou hebben.
//
// Read-only: geen DB-writes, geen TL-writes. Super_admin only.
//
// Geplaatst op fix/finance-3-debug-invoice-inspect — wordt verwijderd in een
// follow-up cleanup-PR zodra diagnose klaar is. NIET koppelen aan UI, NIET
// in vercel.json cron, NIET in admin-seed permissions.
//
// GET ?tl_invoice_id=<uuid>           → direct invoices.info
// GET ?invoice_number=<2026/1027>     → eerst DB-lookup → tl_invoice_id → invoices.info
// GET ?...&force_upsert=1             → BIJKOMEND: roep upsertInvoiceFromTl aan
//                                       met dezelfde shared helper als de cron,
//                                       en vergelijk DB-row vóór/na. Zo zien we
//                                       of de cron deze invoice WEL zou kunnen
//                                       updaten (en wat er dan zou veranderen)
//                                       of dat 'ie throws met een specifieke
//                                       error die nu silent in de cron-catch
//                                       wegvalt.
//
// Response:
//   {
//     query:       { tl_invoice_id, invoice_number, force_upsert },
//     db_row:      { ...invoices kolommen },                  // = "before" als force_upsert=1
//     tl_response: { ...volledige invoices.info data },
//     mapping_diff: {
//       inputs:    { status, paid, payable, due, paid_at, updated_at, invoice_date },
//       mapped:    { status, amount_paid, paid_date },
//       db_actual: { status, amount_paid, paid_date },
//       drift:     [{ field, expected, actual }, ...]
//     },
//     force_upsert_result: {                                  // alleen bij force_upsert=1
//       before:  { status, amount_paid, paid_date, updated_at } | null,
//       result:  { id, invoice_number, status, action } | null,
//       after:   { status, amount_paid, paid_date, updated_at } | null,
//       changed: [{ field, before, after }, ...],
//       error:   string | null,
//       stack:   string | null,
//     } | null
//   }

import { verifyAdmin, supabaseAdmin } from './supabase.js';
import { tlFetch } from './_lib/teamleader-token.js';
import { upsertInvoiceFromTl } from './_lib/invoice-upsert.js';

// Pure helpers — bewust gekopieerd uit _lib/invoice-upsert.js zodat een latere
// refactor daar deze diagnose-snapshot niet stilletjes verandert. Bij verschil
// tussen deze functie en productie-mapping moet je ze handmatig naast elkaar
// leggen — de drift wordt zichtbaar in mapping_diff.
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
function amt(o) {
  if (o == null) return null;
  if (typeof o === 'number') return Number.isFinite(o) ? o : null;
  if (typeof o === 'object') { const n = Number(o.amount); return Number.isFinite(n) ? n : null; }
  const n = Number(o); return Number.isFinite(n) ? n : null;
}
function isoDate(v) { if (!v) return null; const s = String(v); return s.length >= 10 ? s.slice(0, 10) : null; }

function mapStatus(inv, payable, due) {
  const s = String(inv.status || '').toLowerCase();
  if (s === 'draft') return 'concept';
  if (s.includes('credit')) return 'credited';
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
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin only' });
  if (admin.profile.role !== 'super_admin') {
    return res.status(403).json({ error: 'Alleen super_admin' });
  }

  let tlInvoiceId = String(req.query?.tl_invoice_id || '').trim() || null;
  const invoiceNumber = String(req.query?.invoice_number || '').trim() || null;
  const forceUpsert = String(req.query?.force_upsert || '') === '1';
  if (!tlInvoiceId && !invoiceNumber) {
    return res.status(400).json({ error: 'tl_invoice_id of invoice_number vereist' });
  }

  try {
    // 1. DB-row ophalen (op tl_invoice_id of invoice_number).
    let dbQuery = supabaseAdmin.from('invoices').select('*');
    if (tlInvoiceId) dbQuery = dbQuery.eq('tl_invoice_id', tlInvoiceId);
    else dbQuery = dbQuery.eq('invoice_number', invoiceNumber);
    const { data: dbRow, error: dbErr } = await dbQuery.maybeSingle();
    if (dbErr) console.error('[tl-inspect] DB lookup', dbErr.message);

    // 2. Als alleen invoice_number opgegeven: pak tl_invoice_id uit DB-row.
    if (!tlInvoiceId) {
      if (!dbRow) return res.status(404).json({ error: `Geen DB-row voor invoice_number='${invoiceNumber}'` });
      tlInvoiceId = dbRow.tl_invoice_id;
      if (!tlInvoiceId) return res.status(404).json({ error: 'DB-row heeft geen tl_invoice_id (lokale factuur niet in TL)' });
    }

    // 3. TL invoices.info ophalen.
    const r = await tlFetch('/invoices.info', { method: 'POST', body: JSON.stringify({ id: tlInvoiceId }) });
    const text = await r.text().catch(() => '');
    if (!r.ok) {
      return res.status(502).json({
        error: `TL invoices.info HTTP ${r.status}`,
        body: text.slice(0, 500),
        query: { tl_invoice_id: tlInvoiceId, invoice_number: invoiceNumber },
      });
    }
    let inv = null;
    try { inv = JSON.parse(text).data; }
    catch { return res.status(502).json({ error: 'TL-respons niet parsebaar', body: text.slice(0, 500) }); }
    if (!inv) return res.status(502).json({ error: 'TL gaf geen data' });

    // 4. Mapping-snapshot: dezelfde regels als invoice-upsert.js.
    const t = inv.total || {};
    const incl = amt(t.tax_inclusive) ?? amt(t.payable) ?? 0;
    const excl = amt(t.tax_exclusive);
    const payable = amt(t.payable);
    const due = amt(t.due);
    const mappedStatus = mapStatus(inv, payable, due);
    const mappedAmountPaid = (payable != null && due != null)
      ? Math.max(0, r2(payable - due))
      : (inv.paid === true ? r2(incl) : 0);
    const mappedPaidDate = isoDate(inv.paid_at)
      || (mappedStatus === 'paid' ? (isoDate(inv.updated_at) || null) : null);

    // 5. Drift detecteren: wat zou de cron NU naar DB schrijven vs. wat staat er.
    const drift = [];
    if (dbRow) {
      if (dbRow.status !== mappedStatus)
        drift.push({ field: 'status', expected: mappedStatus, actual: dbRow.status });
      if (Number(dbRow.amount_paid) !== Number(mappedAmountPaid))
        drift.push({ field: 'amount_paid', expected: mappedAmountPaid, actual: Number(dbRow.amount_paid) });
      if (String(dbRow.paid_date || '') !== String(mappedPaidDate || ''))
        drift.push({ field: 'paid_date', expected: mappedPaidDate, actual: dbRow.paid_date });
    }

    // 6. Sync-cursor erbij voor context.
    let syncState = null;
    try {
      const { data } = await supabaseAdmin
        .from('sync_state').select('resource, last_updated_since, last_run_at, last_run_processed, last_run_errors')
        .eq('resource', 'invoices').maybeSingle();
      syncState = data || null;
    } catch (e) { console.error('[tl-inspect] sync_state', e.message); }

    // 7. Force-upsert mode: roep dezelfde shared helper aan die de cron
    //    gebruikt en vergelijk DB-row vóór/na. Schrijft naar productie DB —
    //    is idempotent (zelfde upsert die hourly cron al doet). Catch alle
    //    errors expliciet zodat we de stack zien die de cron normaal swallows.
    let forceUpsertResult = null;
    if (forceUpsert) {
      const beforeSnap = dbRow ? {
        status:      dbRow.status,
        amount_paid: Number(dbRow.amount_paid),
        paid_date:   dbRow.paid_date,
        updated_at:  dbRow.updated_at,
      } : null;
      try {
        const upResult = await upsertInvoiceFromTl(tlInvoiceId);
        const { data: afterRow } = await supabaseAdmin
          .from('invoices').select('*').eq('tl_invoice_id', tlInvoiceId).maybeSingle();
        const afterSnap = afterRow ? {
          status:      afterRow.status,
          amount_paid: Number(afterRow.amount_paid),
          paid_date:   afterRow.paid_date,
          updated_at:  afterRow.updated_at,
        } : null;
        const changed = [];
        if (beforeSnap && afterSnap) {
          for (const k of Object.keys(beforeSnap)) {
            const a = beforeSnap[k], b = afterSnap[k];
            const aStr = a == null ? null : String(a);
            const bStr = b == null ? null : String(b);
            if (aStr !== bStr) changed.push({ field: k, before: a, after: b });
          }
        } else if (!beforeSnap && afterSnap) {
          changed.push({ field: '__row__', before: null, after: 'inserted' });
        }
        forceUpsertResult = {
          before: beforeSnap,
          result: upResult,                // { id, invoice_number, status, action }
          after:  afterSnap,
          changed,
          error:  null,
          stack:  null,
        };
        console.log('[tl-inspect:force_upsert] OK', JSON.stringify({
          tl_id: tlInvoiceId, action: upResult.action, changed_count: changed.length,
        }));
      } catch (e) {
        forceUpsertResult = {
          before: beforeSnap,
          result: null,
          after:  null,
          changed: [],
          error:  e.message,
          stack:  e.stack ? String(e.stack).slice(0, 800) : null,
        };
        console.error('[tl-inspect:force_upsert] FAIL', tlInvoiceId, e.message);
      }
    }

    console.log('[tl-inspect]', JSON.stringify({
      tl_id: tlInvoiceId,
      invoice_number: dbRow?.invoice_number || inv.invoice_number,
      tl_status: inv.status,
      tl_paid: inv.paid,
      tl_updated_at: inv.updated_at,
      tl_paid_at: inv.paid_at,
      tl_due: due,
      tl_payable: payable,
      db_status: dbRow?.status,
      mapped_status: mappedStatus,
      drift_count: drift.length,
      cursor_at: syncState?.last_updated_since,
      force_upsert: forceUpsert,
    }));

    return res.status(200).json({
      query: {
        tl_invoice_id: tlInvoiceId,
        invoice_number: invoiceNumber || dbRow?.invoice_number || null,
        force_upsert: forceUpsert,
      },
      db_row: dbRow,
      tl_response: inv,
      mapping_diff: {
        inputs: {
          status:        inv.status ?? null,
          paid:          inv.paid ?? null,
          payable,
          due,
          paid_at:       inv.paid_at ?? null,
          updated_at:    inv.updated_at ?? null,
          invoice_date:  inv.invoice_date ?? null,
        },
        mapped: {
          status:       mappedStatus,
          amount_paid:  mappedAmountPaid,
          paid_date:    mappedPaidDate,
        },
        db_actual: dbRow ? {
          status:       dbRow.status,
          amount_paid:  Number(dbRow.amount_paid),
          paid_date:    dbRow.paid_date,
        } : null,
        drift,
      },
      sync_state: syncState,
      force_upsert_result: forceUpsertResult,
    });
  } catch (e) {
    console.error('[finance-invoice-tl-inspect]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
