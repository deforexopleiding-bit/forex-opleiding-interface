// api/admin/deals-search.js
// GET → zoek backfill-deals voor koppeling aan een historisch event.
// SUPER_ADMIN only. Filter: tl_deal_id NOT NULL, tl_quotation_status in
// {accepted, signed}. Query-params: q (naam / quote_reference / TL-id),
// date_from + date_to (YYYY-MM-DD, filter op created_at), limit (default 50).
//
// Response 200: { deals: [{ id, customer_id, customer_name, customer_email,
//   total_amount, tl_quotation_status, quote_reference, created_at }] }

import { verifyAdmin, supabaseAdmin } from '../supabase.js';

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin only' });
  if (admin.profile.role !== 'super_admin') return res.status(403).json({ error: 'Alleen super_admin' });

  const q         = typeof req.query?.q === 'string' ? req.query.q.trim() : '';
  const dateFrom  = isDate(req.query?.date_from) ? req.query.date_from : null;
  const dateTo    = isDate(req.query?.date_to)   ? req.query.date_to   : null;
  const limit     = Math.min(Math.max(Number(req.query?.limit) || 50, 1), 200);
  // Optioneel status-filter: csv, bv. ?status=accepted,signed. Zonder param →
  // GEEN filter (default). Voor historische attributie zijn álle backfill-
  // deals interessant: TL zet 'sent' vaak nooit door naar 'won', en ook
  // 'no_quotation' rijen (import van deals zonder quotation-id) horen erbij.
  const statusRaw = typeof req.query?.status === 'string' ? req.query.status.trim() : '';
  const statusList = statusRaw
    ? statusRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : [];

  try {
    let query = supabaseAdmin.from('deals')
      .select('id, customer_id, total_amount, tl_deal_id, tl_quotation_id, tl_quotation_status, quote_reference, created_at')
      .not('tl_deal_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (statusList.length) query = query.in('tl_quotation_status', statusList);
    if (dateFrom) query = query.gte('created_at', dateFrom + 'T00:00:00');
    if (dateTo)   query = query.lte('created_at', dateTo   + 'T23:59:59');
    if (q) {
      // OR-filter op quote_reference of tl_deal_id (ilike).
      const safe = q.replace(/[,()]/g, ' ').trim();
      if (safe) query = query.or(`quote_reference.ilike.%${safe}%,tl_deal_id.ilike.%${safe}%`);
    }
    const { data: deals, error: dErr } = await query;
    if (dErr) throw new Error('deals fetch: ' + dErr.message);

    // Verrijk met customer_name + email.
    const custIds = [...new Set((deals || []).map((d) => d.customer_id).filter(Boolean))];
    const custMap = new Map();
    if (custIds.length) {
      const { data: cs } = await supabaseAdmin.from('customers')
        .select('id, is_company, company_name, first_name, last_name, email')
        .in('id', custIds);
      for (const c of (cs || [])) {
        const name = c.is_company
          ? (c.company_name || '(bedrijf)')
          : ((c.first_name || '') + ' ' + (c.last_name || '')).trim() || '(onbekend)';
        custMap.set(c.id, { name, email: c.email || null });
      }
    }
    // Client-side name-filter als q op naam matcht (Supabase kan geen join-ilike op sub-relatie hier).
    let out = (deals || []).map((d) => ({
      id:                  d.id,
      customer_id:         d.customer_id,
      customer_name:       custMap.get(d.customer_id)?.name || '—',
      customer_email:      custMap.get(d.customer_id)?.email || null,
      total_amount:        Number(d.total_amount || 0),
      tl_quotation_status: d.tl_quotation_status || null,
      quote_reference:     d.quote_reference || null,
      tl_deal_id:          d.tl_deal_id || null,
      created_at:          d.created_at || null,
    }));
    if (q) {
      const needle = q.toLowerCase();
      out = out.filter((d) => {
        return String(d.customer_name || '').toLowerCase().includes(needle)
          || String(d.quote_reference || '').toLowerCase().includes(needle)
          || String(d.tl_deal_id || '').toLowerCase().includes(needle);
      });
    }
    return res.status(200).json({ deals: out });
  } catch (e) {
    console.error('[admin/deals-search]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
