// api/incasso-dossiers-list.js
// GET ?status= → dossiers + klant + bureau + snapshot-bedrag. Permission: finance.incasso.manage.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

const VALID_STATUSES = ['aangemeld', 'lopend', 'betaald', 'afgeschreven', 'oninbaar', 'geretourneerd'];

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

  const q = req.query || {};
  const statusFilter = typeof q.status === 'string' && VALID_STATUSES.includes(q.status) ? q.status : null;

  try {
    let query = supabaseAdmin
      .from('dunning_incasso_dossiers')
      .select('id, customer_id, bureau_id, country, status, debt_snapshot, notes, opened_at, updated_at, ' +
        'customer:customer_id(id, first_name, last_name, company_name, is_company, email, phone), ' +
        'bureau:bureau_id(id, name, country)')
      .order('opened_at', { ascending: false })
      .limit(500);
    if (statusFilter) query = query.eq('status', statusFilter);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const items = (data || []).map((d) => {
      const cust = d.customer || null;
      const snap = d.debt_snapshot || {};
      return {
        id                : d.id,
        customer_id       : d.customer_id,
        customer_name     : cust ? customerDisplayName(cust, '(zonder naam)') : null,
        customer_email    : cust?.email || null,
        bureau_id         : d.bureau_id,
        bureau_name       : d.bureau?.name || null,
        country           : d.country,
        status            : d.status,
        total_open_eur    : Number(snap.total_open_eur) || 0,
        total_open_cents  : Number(snap.total_open_cents) || 0,
        open_invoice_count: Number(snap.open_invoice_count) || 0,
        notes             : d.notes,
        opened_at         : d.opened_at,
        updated_at        : d.updated_at,
      };
    });
    return res.status(200).json({ items });
  } catch (e) {
    console.error('[incasso-dossiers-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
