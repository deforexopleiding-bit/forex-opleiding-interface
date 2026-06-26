// api/mentor-offertes-self.js
//
// GET → self-scoped lijst van eigen offertes/deals van de ingelogde gebruiker.
//
// Permission: sales.deal.view (gegate; mentor heeft dit). 403 zonder.
//
// SECURITY — Hard-forced eigenaars-filter:
//   - sales_user_id WORDT HARD GEFORCEERD op auth.uid() uit de Bearer-token.
//   - Eventueel meegestuurde ?sales_user_id van de client wordt GENEGEERD.
//   - Geen user.id → fail-closed (401 — geen ongefilterde return).
//   - Geen owner-injectie mogelijk: requirePermission valideert de token EERST,
//     daarna pakt deze handler de user.id uit dezelfde token (createUserClient).
//     Een geldige token van user X kan NOOIT deals van user Y opvragen.
//
// Response 200: { items: [{ id, customer_name, total_amount, status, date,
//                            quote_reference }] }. Lege lijst = { items: [] }
// (geen error). Datum-sort DESC, limit 10.
//
// 401 = niet-ingelogd; 403 = geen permission; 405 = niet-GET; 500 = interne fout.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const LIST_LIMIT = 10;

function customerDisplayName(c) {
  if (!c) return '—';
  if (c.is_company) {
    return String(c.company_name || '').trim() || '—';
  }
  const fn = String(c.first_name || '').trim();
  const ln = String(c.last_name  || '').trim();
  const joined = [fn, ln].filter(Boolean).join(' ').trim();
  return joined || '—';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // 1. Auth-check via Bearer-token + user.id voor de hard-forced filter.
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !user.id) {
    // Fail-closed: zonder bekende eigenaar NOOIT ongefilterd queryen.
    return res.status(401).json({ error: 'Niet geauthenticeerd' });
  }

  // 2. Permission-gate.
  if (!(await requirePermission(req, 'sales.deal.view'))) {
    return res.status(403).json({ error: 'Geen rechten (sales.deal.view)' });
  }

  try {
    // 3. Self-scoped query.
    // BEWUST GENEGEERD: req.query.sales_user_id of vergelijkbare client-input.
    // De filter is hard-coded op de uit de token gehaalde user.id.
    const { data: deals, error: dErr } = await supabaseAdmin
      .from('deals')
      .select('id, customer_id, total_amount, status, start_date, created_at, quote_reference')
      .eq('sales_user_id', user.id)
      .order('start_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false, nullsFirst: false })
      .limit(LIST_LIMIT);
    if (dErr) throw new Error('deals query: ' + dErr.message);

    const rows = Array.isArray(deals) ? deals : [];
    if (rows.length === 0) return res.status(200).json({ items: [] });

    // 4. Customer-namen ophalen in 1 batch (defensief, falen → '—').
    const customerIds = Array.from(new Set(
      rows.map((d) => d.customer_id).filter((id) => typeof id === 'string' && id.length > 0)
    ));
    let custMap = new Map();
    if (customerIds.length > 0) {
      const { data: custs, error: cErr } = await supabaseAdmin
        .from('customers')
        .select('id, is_company, company_name, first_name, last_name')
        .in('id', customerIds);
      if (cErr) {
        console.warn('[mentor-offertes-self] customers lookup faalde:', cErr.message);
      } else {
        for (const c of (custs || [])) custMap.set(c.id, c);
      }
    }

    const items = rows.map((d) => ({
      id              : d.id,
      customer_name   : customerDisplayName(custMap.get(d.customer_id)),
      total_amount    : Number(d.total_amount) || 0,
      status          : d.status || null,
      date            : d.start_date || d.created_at || null,
      quote_reference : d.quote_reference || null,
    }));

    return res.status(200).json({ items });
  } catch (e) {
    console.error('[mentor-offertes-self]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
