// api/finance-invoice-pdf.js
// GET ?tl_invoice_id=<uuid> OF ?invoice_id=<uuid> → tijdelijke TL-download-URL
// voor de factuur-PDF. Permission: finance.invoice.view. Read-only (geen
// TL-mutatie behalve een fail-soft persist van een self-healed tl_invoice_id).
//
// Embedden van een PDF via <iframe src> kan geen Bearer-header meesturen; daarom
// geeft dit endpoint de (kortlevende) signed TL-URL terug als JSON, en opent de
// frontend die in een nieuw tabblad. Lukt het niet → frontend valt terug op de
// "Open in Teamleader"-knop.
//
// BROK FINANCE-INVOICE-PDF (2026-08-19): backward-compat + self-heal.
//   - Accepteert nu OOK `invoice_id` (onze DB-UUID). Endpoint zoekt de rij op,
//     gebruikt haar `tl_invoice_id` als aanwezig, of doet een self-heal via
//     TL /invoices.list filter op `invoice_number` (analoog aan de offerte-flow
//     self-heal). Bij match wordt de tl_invoice_id fail-soft gepersisteerd.
//   - Als de factuur in onze DB NIET in TL bestaat (0 matches): 404 met code
//     `NOT_IN_TL` zodat de frontend een nette melding kan tonen i.p.v. een
//     rauwe "tl_invoice_id vereist".
//
// Response-shapes:
//   200 { url, expires? }                             — happy path
//   400 { error: 'invoice_id of tl_invoice_id vereist' }
//   404 { code: 'NOT_IN_TL', error: '…' }             — DB-rij bestaat maar TL heeft geen match
//   404 { code: 'INVOICE_NOT_FOUND', error: '…' }     — DB-rij bestaat niet
//   502/500 { error }                                 — TL-storing / interne fout

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { tlFetch } from './_lib/teamleader-token.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Lookup TL-invoice op invoice_number. Returnt tl_invoice_id (string) of null.
// Filter-shape volgt finance-tl-invoice-sync.js: /invoices.list met filter.
// TL zou 0 of 1 match moeten geven (invoice_number is uniek per dept).
async function resolveTlInvoiceIdByNumber(invoiceNumber, tlDepartmentId) {
  const filter = { invoice_number: String(invoiceNumber) };
  if (tlDepartmentId) filter.department_id = String(tlDepartmentId);
  try {
    const r = await tlFetch('/invoices.list', {
      method: 'POST',
      body: JSON.stringify({ filter, page: { size: 5, number: 1 } }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.warn('[finance-invoice-pdf] self-heal invoices.list HTTP', r.status, txt.slice(0, 200));
      return null;
    }
    const data = await r.json();
    const list = Array.isArray(data?.data) ? data.data : [];
    if (!list.length) return null;
    // Exact-match op invoice_number omdat TL's filter soms fuzzy is.
    const exact = list.find((x) => String(x.invoice_number || '').trim() === String(invoiceNumber).trim());
    return (exact && exact.id) || (list[0] && list[0].id) || null;
  } catch (e) {
    console.warn('[finance-invoice-pdf] self-heal exception:', e?.message || e);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.invoice.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.invoice.view)' });
  }

  let tlInvoiceId = req.query?.tl_invoice_id ? String(req.query.tl_invoice_id).trim() : null;
  const invoiceId  = req.query?.invoice_id    ? String(req.query.invoice_id).trim()    : null;
  if (!tlInvoiceId && !invoiceId) {
    return res.status(400).json({ error: 'invoice_id of tl_invoice_id vereist' });
  }
  if (invoiceId && !UUID_RE.test(invoiceId)) {
    return res.status(400).json({ error: 'invoice_id moet een uuid zijn' });
  }

  // Als alleen invoice_id gegeven is: DB-lookup + eventuele self-heal.
  if (!tlInvoiceId && invoiceId) {
    const { data: inv, error: dbErr } = await supabaseAdmin
      .from('invoices')
      .select('id, tl_invoice_id, invoice_number, tl_department_id')
      .eq('id', invoiceId)
      .maybeSingle();
    if (dbErr) {
      console.error('[finance-invoice-pdf] db lookup:', dbErr.message);
      return res.status(500).json({ error: 'DB-lookup mislukt' });
    }
    if (!inv) {
      return res.status(404).json({ code: 'INVOICE_NOT_FOUND', error: 'Factuur niet gevonden.' });
    }
    if (inv.tl_invoice_id) {
      tlInvoiceId = inv.tl_invoice_id;
    } else if (inv.invoice_number && !String(inv.invoice_number).startsWith('CONCEPT-')) {
      // Self-heal: probeer TL-lookup op invoice_number.
      const resolved = await resolveTlInvoiceIdByNumber(inv.invoice_number, inv.tl_department_id);
      if (resolved) {
        tlInvoiceId = resolved;
        // Fail-soft persist zodat volgende PDF-klik direct raakt.
        try {
          await supabaseAdmin.from('invoices').update({ tl_invoice_id: resolved }).eq('id', invoiceId);
        } catch (e) {
          console.warn('[finance-invoice-pdf] persist tl_invoice_id fail-soft:', e?.message || e);
        }
      } else {
        return res.status(404).json({
          code: 'NOT_IN_TL',
          error: 'Geen TeamLeader-factuur — PDF niet beschikbaar (factuur nooit gepusht naar TL).',
        });
      }
    } else {
      // Geen invoice_number of CONCEPT-*: geen TL-koppeling mogelijk.
      return res.status(404).json({
        code: 'NOT_IN_TL',
        error: 'Geen TeamLeader-factuur — PDF niet beschikbaar (concept-status).',
      });
    }
  }

  try {
    const r = await tlFetch('/invoices.download', { method: 'POST', body: JSON.stringify({ id: tlInvoiceId, format: 'pdf' }) });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.error('[finance-invoice-pdf] invoices.download HTTP', r.status, txt.slice(0, 200));
      // 404 op TL: tl_invoice_id was stale → wis + meld NOT_IN_TL zodat frontend zelf-heals bij volgende klik.
      if (r.status === 404 && invoiceId) {
        try { await supabaseAdmin.from('invoices').update({ tl_invoice_id: null }).eq('id', invoiceId); } catch (_) {}
        return res.status(404).json({ code: 'NOT_IN_TL', error: 'TeamLeader-factuur bestaat niet meer — PDF niet beschikbaar.' });
      }
      return res.status(502).json({ error: `TL invoices.download HTTP ${r.status}` });
    }
    const data = await r.json();
    // TL geeft doorgaans { data: { location, expires } }.
    const url = data?.data?.location || data?.location || null;
    if (!url) return res.status(502).json({ error: 'Geen download-URL in TL-response' });
    return res.status(200).json({ url, expires: data?.data?.expires || null });
  } catch (e) {
    console.error('[finance-invoice-pdf]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
