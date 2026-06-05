// api/finance-invoice-credit.js
// POST → factuur (volledig) crediteren via TL invoices.credit. Permission: finance.invoice.credit.
// MINIMAL parameters → TL gebruikt zijn default-mapping (geen grootboek/BTW-overrides);
// Combidesk → e-boekhouden flow blijft identiek aan handmatig TL-knopwerk.
// TL-first + validate-first. Na succes: re-sync creditnota's voor deze factuur.
//
// Body: { invoice_id, description? }
// Apiary-shape (te verifiëren met testplan): { id: <tl_invoice_id>, description? }
// (creditPartially bestaat ook; wij gebruiken bewust de volledige credit-call.)

import { createUserClient, supabaseAdmin } from './supabase.js';
import { tlFetch, getActiveToken } from './_lib/teamleader-token.js';
import { getClientIp } from './_lib/audit-customer.js';
import { requirePermission } from './_lib/requirePermission.js';
import { upsertInvoiceFromTl } from './_lib/invoice-upsert.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function tlCall(path, body, attempt = 0) {
  await sleep(150);
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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.invoice.credit'))) return res.status(403).json({ error: 'Geen rechten (finance.invoice.credit)' });

  const { invoice_id, description } = req.body || {};
  if (!invoice_id) return res.status(400).json({ error: 'invoice_id vereist' });

  try {
    const { data: inv } = await supabaseAdmin.from('invoices')
      .select('id, customer_id, tl_invoice_id, invoice_number, amount_total, status').eq('id', invoice_id).maybeSingle();
    if (!inv) return res.status(404).json({ error: 'Factuur niet gevonden' });
    if (!inv.tl_invoice_id) return res.status(400).json({ error: 'Factuur heeft geen Teamleader-id' });
    if (inv.status === 'concept') return res.status(409).json({ error: 'Conceptfacturen kunnen niet gecrediteerd worden (verwijder ze).' });

    const body = { id: inv.tl_invoice_id };
    if (description) body.description = String(description);
    console.log('[finance-invoice-credit] payload', JSON.stringify(body));

    let pr, prText = '';
    try { pr = await tlCall('/invoices.credit', body); prText = await pr.text().catch(() => ''); }
    catch (netErr) { console.error('[finance-invoice-credit] netwerk', netErr.message); return res.status(502).json({ error: 'Kon Teamleader niet bereiken: ' + netErr.message }); }
    if (!pr.ok) {
      console.error('[finance-invoice-credit] GEWEIGERD | HTTP', pr.status, '| payload=', JSON.stringify(body), '| response=', prText);
      return res.status(422).json({ error: `Teamleader weigerde de creditnota (HTTP ${pr.status}).`, tl_status: pr.status, tl_response: prText });
    }
    let creditId = null; try { creditId = JSON.parse(prText)?.data?.id || null; } catch {}
    console.log('[finance-invoice-credit] OK | HTTP', pr.status, '| credit_note_id', creditId);

    // Re-sync deze ene creditnota (zodat onze credit_notes + credited_amount + 'Gecrediteerd'-pill
    // direct kloppen). Geen externe HTTP — lees de creditnota uit TL en upsert hier.
    let synced = false;
    try {
      if (creditId) {
        const cr = await tlCall('/creditNotes.info', { id: creditId });
        if (cr.ok) {
          const cn = (await cr.json()).data || {};
          const incl = r2(amt(cn.total?.tax_inclusive) ?? amt(cn.total?.payable) ?? 0);
          const tlInv = cn.invoice?.id || inv.tl_invoice_id;
          const row = {
            tl_credit_note_id: cn.id,
            credit_note_number: cn.invoice_number || cn.number || cn.credit_note_number || null,
            tl_invoice_id: tlInv, invoice_id: inv.id,
            department_id: cn.department?.id || null, amount_total: incl,
            credit_note_date: isoDate(cn.credit_note_date || cn.date || cn.booked_on),
            status: cn.status || null, updated_at: new Date().toISOString(),
          };
          const { data: ex } = await supabaseAdmin.from('credit_notes').select('id').eq('tl_credit_note_id', cn.id).maybeSingle();
          if (ex) await supabaseAdmin.from('credit_notes').update(row).eq('id', ex.id);
          else await supabaseAdmin.from('credit_notes').insert(row);
          // Herbereken credited_amount.
          const { data: rows } = await supabaseAdmin.from('credit_notes').select('amount_total').eq('invoice_id', inv.id);
          const sum = r2((rows || []).reduce((a, r) => a + (Number(r.amount_total) || 0), 0));
          await supabaseAdmin.from('invoices').update({ credited_amount: sum, updated_at: new Date().toISOString() }).eq('id', inv.id);
          synced = true;
        } else { console.error('[finance-invoice-credit] creditNotes.info HTTP', cr.status); }
      }
    } catch (e) { console.error('[finance-invoice-credit] sync', e.message); }

    // Re-upsert de originele factuur — status/payable kan na credit gewijzigd zijn.
    try { await upsertInvoiceFromTl(inv.tl_invoice_id); }
    catch (e) { console.error('[finance-invoice-credit] invoice resync', e.message); }

    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id: user.id, action: 'invoice.credit', entity_type: 'invoice', entity_id: inv.id,
        after_json: { tl_credit_note_id: creditId, description: description || null, synced },
        reason_text: `Factuur ${inv.invoice_number} gecrediteerd (creditnota ${creditId || '?'})`, ip_address: getClientIp(req),
      });
    } catch (e) { console.error('[finance-invoice-credit] audit', e.message); }

    return res.status(200).json({ success: true, invoice_id: inv.id, tl_credit_note_id: creditId, synced });
  } catch (e) {
    console.error('[finance-invoice-credit]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
