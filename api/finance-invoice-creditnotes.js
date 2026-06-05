// api/finance-invoice-creditnotes.js
// GET ?invoice_id=<uuid> → gekoppelde creditnota's + netto-totalen voor één factuur.
// Permission: finance.invoice.view. Read-only.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.invoice.view'))) return res.status(403).json({ error: 'Geen rechten (finance.invoice.view)' });

  const invoiceId = req.query?.invoice_id || null;
  if (!invoiceId) return res.status(400).json({ error: 'invoice_id vereist' });

  try {
    const { data: inv } = await supabaseAdmin.from('invoices')
      .select('id, amount_total, amount_paid, credited_amount').eq('id', invoiceId).maybeSingle();
    if (!inv) return res.status(404).json({ error: 'Factuur niet gevonden' });

    const { data: cns } = await supabaseAdmin.from('credit_notes')
      .select('credit_note_number, credit_note_date, amount_total, status')
      .eq('invoice_id', invoiceId).order('credit_note_date', { ascending: false });

    const total = r2(inv.amount_total);
    const credited = r2(inv.credited_amount);
    return res.status(200).json({
      invoice_id: inv.id,
      amount_total: total,
      amount_paid: r2(inv.amount_paid),
      credited_amount: credited,
      amount_net: r2(total - credited),
      credit_notes: (cns || []).map(c => ({
        number: c.credit_note_number || '—',
        date: c.credit_note_date || null,
        amount_total: r2(c.amount_total),
        status: c.status || null,
      })),
    });
  } catch (e) {
    console.error('[finance-invoice-creditnotes]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
