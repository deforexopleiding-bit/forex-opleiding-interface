// api/incasso-dossier-detail.js
// GET ?id= → { dossier, customer, invoices, arrangements, conversations, dunning_log }
// Read-only context-aggregatie. Permission: finance.incasso.manage.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getCreditedDebt } from './_lib/credited-debt.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.incasso.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.incasso.manage)' });
  }

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) verplicht' });

  try {
    const { data: dossier, error: dErr } = await supabaseAdmin
      .from('dunning_incasso_dossiers')
      .select('id, customer_id, bureau_id, country, status, debt_snapshot, notes, pdf_ref, opened_by, opened_at, updated_at, ' +
        'bureau:bureau_id(id, name, email, country, address)')
      .eq('id', id).maybeSingle();
    if (dErr) throw new Error('dossier lookup: ' + dErr.message);
    if (!dossier) return res.status(404).json({ error: 'Dossier niet gevonden' });

    const cid = dossier.customer_id;

    // Parallel: customer, all invoices, arrangements, conversations, log.
    const [
      { data: customer },
      { data: invoices },
      { data: arrangements },
      { data: conversations },
      { data: dunningLog },
    ] = await Promise.all([
      supabaseAdmin.from('customers')
        .select('id, first_name, last_name, company_name, is_company, email, phone, archived_at, anonymized_at, created_at')
        .eq('id', cid).maybeSingle(),
      supabaseAdmin.from('invoices')
        .select('id, invoice_number, amount_total, amount_paid, credited_amount, due_date, issue_date, status, paid_date')
        .eq('customer_id', cid).order('issue_date', { ascending: false }).limit(200),
      supabaseAdmin.from('payment_arrangements')
        .select('id, type, status, details, created_at')
        .eq('customer_id', cid).order('created_at', { ascending: false }).limit(50),
      supabaseAdmin.from('whatsapp_conversations')
        .select('id, phone_number, status, last_message_at, last_message_preview, last_inbound_at, unread_count')
        .eq('customer_id', cid).order('last_message_at', { ascending: false, nullsFirst: false }).limit(20),
      supabaseAdmin.from('dunning_log')
        .select('id, event_type, payload, created_at')
        .filter('payload->>customer_id', 'eq', cid)
        .order('created_at', { ascending: false }).limit(100),
    ]);

    // WIK/BE-brief markering: kijk of er een dunning_log event is over brief-verstuurd.
    const wik_letter_sent = (dunningLog || []).some((r) => {
      const type = String(r.event_type || '');
      return type === 'wik_letter_sent' || type === 'be_letter_sent' || type === 'brief_verstuurd';
    });

    // Crediteerronde-historie (PR-3 zichtbaarheid). Fail-soft — helper geeft
    // lege agg terug bij DB-fout of ontbrekende tabel.
    const credited_debt = await getCreditedDebt(cid);

    return res.status(200).json({
      ok           : true,
      dossier,
      customer     : customer || null,
      invoices     : invoices || [],
      arrangements : arrangements || [],
      conversations: conversations || [],
      dunning_log  : dunningLog || [],
      credited_debt,
      flags        : { wik_letter_sent },
    });
  } catch (e) {
    console.error('[incasso-dossier-detail]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
